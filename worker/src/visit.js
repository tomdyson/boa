// What a visitor's request to /<slug>/… gets. Runs inside that app's Durable Object.
//   Password apps: a shared password -> signed cookie scoped to /<slug>/.
//   Open apps: no sign-in at all, anyone with the address can read and write.
//   Private apps: each browser gets a signed visitor cookie and its own set of answers; nobody
//   sees anyone else's. The owner reads them all through the admin API.
import { fingerprint, makeToken, readToken } from "./auth.js";
import { FILE_RE, SESSION_DAYS, VISITOR_DAYS } from "./limits.js";
import { owner } from "./owner.js";
import { enterPage, linkExpiredPage, lockedPage, loginPage, notFoundPage, SEC_HEADERS } from "./pages.js";
import CLIENT_JS from "./boa.client.js";

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS } });
export const err = (msg, status) => json({ error: msg }, status);
export const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
export const getCookie = (req, name) =>
  (req.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);

// A rough, human label for a visitor's browser ("Safari on iPhone"), for the owner's view of who visited.
function deviceLabel(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome"
    : /Version\/.*Safari/.test(ua) ? "Safari" : /Claude\//.test(ua) ? "Claude app" : "";
  return [browser || "a browser", os && `on ${os}`].filter(Boolean).join(" ");
}

function withCookie(res, cookie) {
  const r = new Response(res.body, res);
  r.headers.append("Set-Cookie", cookie);
  return r;
}

export const redirect = (location, cookies = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", ...SEC_HEADERS });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
};

export async function visit(store, env, req) {
  const url = new URL(req.url);
  // Split before decoding, so an encoded "/" inside a key can't invent extra path segments.
  const parts = url.pathname.split("/").filter(Boolean).map(decode);
  if (parts.includes(null)) return notFoundPage();
  const slug = parts[0];
  const gate = store.gate();
  if (!gate.exists) return notFoundPage();
  const sub = parts.slice(1).join("/") + (url.pathname.endsWith("/") && parts.length > 1 ? "/" : "");
  const secret = env.SESSION_SECRET;
  const fp = fingerprint(gate.pw_hash);

  // Cookies are Secure everywhere except a Worker running on this computer, which has no https.
  const attrs = `Path=/${slug}/; ${["127.0.0.1", "localhost"].includes(url.hostname) ? "" : "Secure; "}SameSite=Lax`;
  const sessionCookie = async () =>
    `boa=${await makeToken(secret, { k: "session", s: slug, f: fp, e: Date.now() + SESSION_DAYS * 864e5 })}; ${attrs}; HttpOnly; Max-Age=${SESSION_DAYS * 86400}`;
  const visitorCookie = async (v) =>
    `boa_v=${await makeToken(secret, { k: "visitor", s: slug, v, e: Date.now() + VISITOR_DAYS * 864e5 })}; ${attrs}; HttpOnly; Max-Age=${VISITOR_DAYS * 86400}`;

  // The owner's page has its own sign-in, separate from visitors' and from the password.
  if (sub === "_owner" || sub.startsWith("_owner/")) return owner(store, env, req, { slug, sub: sub.slice("_owner".length + 1), url, title: gate.title, attrs });

  // An open app has no sign-in: its login route just leads to the page.
  if (gate.open && sub === "_login") return redirect(`/${slug}/`);

  if (sub === "_login" && req.method === "POST") {
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const form = await req.formData().catch(() => null);
    const result = await store.checkLogin(ip, String(form?.get("password") || ""));
    if (result === "blocked") return lockedPage(gate.title);
    if (result === "wrong") {
      await new Promise((r) => setTimeout(r, 750));
      return loginPage(slug, gate.title, "That password isn't right.");
    }
    return redirect(`/${slug}/`, [await sessionCookie()]);
  }

  // One-time entry link from `boa link`: signs the visitor in without the password.
  // Opening it (GET) only shows a Continue button; pressing that (POST) is what uses the link.
  // Message apps and mail scanners fetch addresses to build previews, and must not use it up.
  if (sub === "_enter") {
    const posted = req.method === "POST";
    const t = posted ? String((await req.formData().catch(() => null))?.get("t") || "") : url.searchParams.get("t");
    const p = await readToken(secret, t, "enter");
    if (!p || p.s !== slug || p.f !== fp) return linkExpiredPage();
    if (!posted) return store.nonceUsed(p.n) ? linkExpiredPage() : enterPage(`/${slug}/_enter`, gate.title, t);
    if (!store.useNonce(p.n, p.e)) return linkExpiredPage();
    const cookies = [await sessionCookie()];
    if (p.a) cookies.push(`boa_name=${encodeURIComponent(p.a)}; ${attrs}; Max-Age=600`);
    // A link made for one visitor (`boa link --visitor`) opens their private answers, say on another device.
    if (p.v) cookies.push(await visitorCookie(p.v));
    return redirect(`/${slug}/`, cookies);
  }

  if (sub === "_logout") return redirect(`/${slug}/`, [`boa=; ${attrs}; HttpOnly; Max-Age=0`]);

  // The private link shown after a booking. Like a one-time link, it does nothing until Continue is
  // pressed; unlike one, it keeps working, so the person can come back to their booking.
  if (sub === "_mine") {
    const posted = req.method === "POST";
    const t = posted ? String((await req.formData().catch(() => null))?.get("t") || "") : url.searchParams.get("t");
    const p = await readToken(secret, t, "mine");
    if (!p || p.s !== slug) return linkExpiredPage();
    if (!posted) return enterPage(`/${slug}/_mine`, gate.title, t, "This link opens your own booking on this device, so you can change or cancel it.");
    return redirect(`/${slug}/`, [await visitorCookie(p.v)]);
  }

  if (!gate.open) {
    const p = await readToken(secret, getCookie(req, "boa"), "session");
    if (!(p && p.s === slug && p.f === fp)) return sub.startsWith("_api") ? err("unauthorised", 401) : loginPage(slug, gate.title);
  }

  // Find this browser's visitor id, or give it one (the cookie is set on this response). It says
  // which answers are theirs in a private app, and which bookings are theirs in any app.
  let newVisitorCookie = null;
  const p = await readToken(secret, getCookie(req, "boa_v"), "visitor");
  let visitor = p && p.s === slug ? p.v : null;
  if (!visitor) {
    if (sub === "_api/live") {
      if (gate.private) return err("no visitor", 401);
    } else {
      visitor = crypto.randomUUID();
      newVisitorCookie = await visitorCookie(visitor);
    }
  }
  const res = await serve(store, req, { slug, sub, visitor, isPrivate: gate.private, origin: url.origin });
  return newVisitorCookie ? withCookie(res, newVisitorCookie) : res;
}

// visitor: this browser. mine: the visitor whose answers these are, which is nobody in a shared app.
async function serve(store, req, { slug, sub, visitor, isPrivate, origin }) {
  const mine = isPrivate ? visitor : null;
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const author = () => decode(req.headers.get("X-Boa-Author") || "");
  const visitorInfo = () => {
    const info = store.info();
    // Private apps: how many others have answered is none of a visitor's business. Nor are bookings, anywhere.
    if (isPrivate) for (const k of ["answers", "last_at", "visitors", "visited"]) delete info[k];
    delete info.bookings;
    return info;
  };
  const myBookings = async () => {
    const bookings = store.myBookings(visitor);
    return { bookings, link: bookings.length ? await store.mineLink(slug, origin, visitor) : null };
  };

  if (sub === "_boa.js") {
    return new Response(CLIENT_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "private, no-cache", ...SEC_HEADERS } });
  }
  // Everything a page needs when it opens, in one request.
  if (sub === "_api/start") {
    if (mine) store.recordVisit(mine, author(), deviceLabel(req.headers.get("User-Agent") || ""));
    return json({ info: visitorInfo(), state: store.getState(mine), ...(await myBookings()) });
  }
  if (sub === "_api/info") return json(visitorInfo());
  if (sub === "_api/state" && req.method === "GET") {
    if (mine) store.recordVisit(mine, author(), deviceLabel(req.headers.get("User-Agent") || ""));
    return json(store.getState(mine));
  }
  if (sub.startsWith("_api/state/") && req.method === "PUT") {
    if (store.tooFast(visitor, ip)) return err("too fast", 429);
    const key = sub.slice("_api/state/".length);
    const body = await req.json().catch(() => null);
    if (!body || !("value" in body)) return err("expected {value}", 400);
    const result = store.setState(key, body.value, author() || "anonymous", false, mine);
    if (result.error) return err(result.error, result.error === "closed" ? 423 : 400);
    return json(result.row);
  }
  if (sub === "_api/bookings" && req.method === "GET") return json(await myBookings());
  if (sub.startsWith("_api/book/")) {
    const limit = sub.slice("_api/book/".length);
    if (req.method !== "POST" && req.method !== "DELETE") return err("method not allowed", 405);
    if (store.tooFast(visitor, ip)) return err("too fast", 429);
    const result = req.method === "POST"
      ? store.book(visitor, ip, limit, (await req.json().catch(() => null)) || {})
      : store.cancelBooking(visitor, limit);
    if (result.error) return err(result.error, result.status);
    return json({ ...result, ...(await myBookings()) });
  }
  if (sub === "_api/live") {
    if (req.headers.get("Upgrade") !== "websocket") return err("expected websocket", 426);
    // The visitor comes from the signed cookie, never from anything else the browser sent.
    return store.acceptSocket(visitor);
  }
  if (sub.startsWith("_")) return notFoundPage();

  return serveFile(store, req, sub);
}

function serveFile(store, req, sub) {
  const path = !sub || sub.endsWith("/") ? `${sub}index.html` : sub;
  if (!FILE_RE.test(path)) return notFoundPage();
  const f = store.fileMeta(path);
  if (!f) return notFoundPage();
  const etag = `"${f.etag}"`;
  const headers = new Headers({ "Content-Type": f.type, ETag: etag, "Cache-Control": "private, no-cache", ...SEC_HEADERS });
  const seen = (req.headers.get("If-None-Match") || "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (seen.includes(etag)) return new Response(null, { status: 304, headers });
  if (f.pieces === 1) return new Response(store.filePiece(path, 0), { headers });
  // Larger files go out a piece at a time, so the whole file is never held in memory.
  let seq = 0;
  const body = new ReadableStream({
    pull(controller) {
      const piece = seq < f.pieces ? store.filePiece(path, seq++) : null;
      if (piece) controller.enqueue(new Uint8Array(piece));
      if (!piece || seq >= f.pieces) controller.close();
    },
  });
  return new Response(body, { headers });
}
