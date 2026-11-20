// boa: one Worker hosts every app at /<slug>/.
//   Each app has a Durable Object holding its files, settings, answers, history and live sockets,
//   and that object answers visitors' requests itself (visit.js). The Registry lists the apps.
//   Here: the admin API for the boa command (Authorization: Bearer $ADMIN_TOKEN on /_admin/*),
//   the shared files every page uses (/_boa/*), and handing each visitor request to its app.
import { safeEqual } from "./auth.js";
import { FILE_RE, LIMITS, SLUG_RE } from "./limits.js";
import { notFoundPage, restingPage, SEC_HEADERS } from "./pages.js";
import { decode, err, json } from "./visit.js";
import { VERSION } from "./version.js";
import ALPINE_JS from "./vendor/alpine.client.js";
import GOWUN_400 from "./vendor/gowun-batang-400.woff2";
import GOWUN_700 from "./vendor/gowun-batang-700.woff2";
import INTER from "./vendor/inter.woff2";

export { AppStore, Registry } from "./store.js";

const appStub = (env, slug) => env.APP.get(env.APP.idFromName(slug));
const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

const FONTS_CSS = `@font-face{font-family:'Gowun Batang';font-style:normal;font-weight:400;font-display:swap;src:url(/_boa/gowun-batang-400.woff2) format('woff2')}
@font-face{font-family:'Gowun Batang';font-style:normal;font-weight:700;font-display:swap;src:url(/_boa/gowun-batang-700.woff2) format('woff2')}
@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url(/_boa/inter.woff2) format('woff2')}
`;
// Alpine.js and the fonts: the same for every app and not secret, so no sign-in and a day's caching.
const SHARED = {
  "alpine.js": [ALPINE_JS, "text/javascript; charset=utf-8"],
  "fonts.css": [FONTS_CSS, "text/css; charset=utf-8"],
  "gowun-batang-400.woff2": [GOWUN_400, "font/woff2"],
  "gowun-batang-700.woff2": [GOWUN_700, "font/woff2"],
  "inter.woff2": [INTER, "font/woff2"],
};

export default {
  async fetch(req, env) {
    // Refuse everything until both secrets exist: an unset ADMIN_TOKEN would otherwise accept the
    // literal header "Bearer undefined".
    if (!env.ADMIN_TOKEN || !env.SESSION_SECRET) return new Response("Not configured", { status: 503 });
    const url = new URL(req.url);
    const local = ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol === "http:" && !local) return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "_boa") {
      const file = SHARED[parts[1]];
      if (!file || parts.length !== 2) return notFoundPage();
      return new Response(file[0], { headers: { "Content-Type": file[1], "Cache-Control": "public, max-age=86400", ...SEC_HEADERS } });
    }
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain", ...SEC_HEADERS } });

    try {
      if (parts[0] === "_admin") {
        if (!safeEqual(req.headers.get("Authorization") || "", `Bearer ${env.ADMIN_TOKEN}`)) return err("unauthorised", 401);
        const decoded = parts.slice(1).map(decode);
        if (decoded.includes(null)) return err("bad address", 400);
        return await admin(req, env, url, decoded);
      }
      const slug = parts[0];
      if (!slug || !SLUG_RE.test(slug)) return notFoundPage();
      if (url.pathname === `/${slug}`) return Response.redirect(`${url.origin}/${slug}/${url.search}`, 302);
      return await appStub(env, slug).fetch(req);
    } catch (e) {
      // Most likely the free plan's daily allowance has run out. Say so plainly rather than show an error code.
      console.error(e);
      return parts[0] === "_admin" ? err(`the Worker could not finish that: ${e.message}`, 503) : restingPage();
    }
  },
};

async function admin(req, env, url, parts) {
  const [resource, slug, sub, ...rest] = parts;
  const m = req.method;
  if (!resource && m === "GET") return json({ version: VERSION });
  if (resource !== "apps") return err("not found", 404);

  if (!slug) {
    if (m !== "GET") return err("method not allowed", 405);
    const slugs = await registry(env).list();
    const apps = await Promise.all(slugs.map(async (s) => ({ slug: s, url: `${url.origin}/${s}/`, ...(await appStub(env, s).info()) })));
    return json(apps);
  }
  if (!SLUG_RE.test(slug)) return err("bad name: lowercase letters, digits and hyphens, 2 to 41 characters", 400);
  const app = appStub(env, slug);
  const exists = await app.exists();

  if (!sub) {
    if (m === "GET") return exists ? json({ slug, url: `${url.origin}/${slug}/`, ...(await app.info()) }) : err("no such app", 404);
    if (m === "PUT") {
      const info = await app.configure(slug, (await req.json().catch(() => null)) || {});
      if (info.error) return err(info.error, 400);
      await registry(env).add(slug);
      return json({ slug, url: `${url.origin}/${slug}/`, ...info });
    }
    if (m === "DELETE") {
      const r = await app.destroy();
      await registry(env).remove(slug);
      return json(r);
    }
    return err("method not allowed", 405);
  }

  if (!exists) return err("no such app", 404);

  if (sub === "files") {
    const path = rest.join("/");
    if (!path && m === "GET") return json(await app.listFiles());
    if (!FILE_RE.test(path)) return err("bad path: no part may start with an underscore, and no '..'", 400);
    if (m === "PUT") {
      // One piece of a file (or all of a small one). The command sends big files as several pieces.
      if (Number(req.headers.get("Content-Length") || 0) > LIMITS.pieceBytes) return err("piece too large: send files in pieces of at most 1 MB", 413);
      const bytes = await req.arrayBuffer();
      const r = await app.putFilePiece({
        path,
        type: req.headers.get("Content-Type") || "application/octet-stream",
        etag: req.headers.get("X-Boa-Etag"),
        upload: req.headers.get("X-Boa-Upload"),
        part: Number(req.headers.get("X-Boa-Part") || 0),
        parts: Number(req.headers.get("X-Boa-Parts") || 1),
      }, bytes);
      return r.error ? err(r.error, r.status || 400) : json(r);
    }
    if (m === "DELETE") return json(await app.deleteFile(path));
    return err("method not allowed", 405);
  }

  if (sub === "export" && m === "GET") return json(await app.exportAll());

  if (sub === "state") {
    if (!rest.length && m === "DELETE") return json(await app.clearState());
    if (rest.length && m === "PUT") {
      // Admin write (seeding, or answering as the owner). Works even when the app is closed.
      const body = (await req.json().catch(() => null)) || {};
      const info = await app.info();
      if (info.private && !body.visitor) return err("private app: say which visitor (visitor id)", 400);
      const result = await app.setState(rest.join("/"), body.value, body.author || "Owner", true, body.visitor || null);
      return result.error ? err(result.error, 400) : json(result.row);
    }
    return err("method not allowed", 405);
  }

  if (sub === "visitors" && rest[0] === "merge" && m === "POST") {
    // Private apps: {from, into} visitor ids. One person, two browsers, becomes one visitor.
    if (!(await app.info()).private) return err("only private apps have visitors", 400);
    const body = (await req.json().catch(() => null)) || {};
    const result = await app.mergeVisitors(String(body.from || ""), String(body.into || ""));
    return result.error ? err(result.error, 400) : json(result);
  }

  // Remove one booking, by its number (shown by `boa data`).
  if (sub === "bookings" && rest.length === 1 && m === "DELETE") {
    const result = await app.unbook(Number(rest[0]));
    return result.error ? err(result.error, 404) : json(result);
  }

  if (sub === "links" && m === "POST") {
    const result = await app.mintLink(slug, url.origin, (await req.json().catch(() => null)) || {});
    return result.error ? err(result.error, 400) : json(result);
  }

  return err("not found", 404);
}
