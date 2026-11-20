#!/usr/bin/env node
"use strict";
// End-to-end check of everything the boa Worker promises. Makes a few throwaway apps (their names
// start with "check-"), uses them as visitors would over plain HTTP and a raw WebSocket, then
// deletes them. No packages.
//
//   node scripts/smoke.js --local     against `boa dev` on this computer
//   node scripts/smoke.js             against the real Worker (same as `boa check`)

const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const crypto = require("node:crypto");
const cli = require("../cli/boa");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Site {
  constructor(base, token) {
    this.base = base.replace(/\/+$/, "");
    this.url = new URL(this.base);
    this.https = this.url.protocol === "https:";
    this.token = token;
  }

  // body: a Buffer is sent as it is, anything else as JSON. form: sent as a posted form.
  async req(method, pathname, { body, headers = {}, admin = false, form } = {}) {
    const h = { ...headers };
    if (admin) h.Authorization = `Bearer ${this.token}`;
    let data = null;
    if (form) {
      data = Buffer.from(new URLSearchParams(form).toString());
      h["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (Buffer.isBuffer(body)) {
      data = body;
    } else if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      h["Content-Type"] = "application/json";
    }
    const r = await cli.request(this.base, method, pathname, { headers: h, body: data, timeout: 60000 });
    r.text = r.body.toString("utf8");
    r.json = () => {
      try {
        return JSON.parse(r.text);
      } catch {
        return {};
      }
    };
    return r;
  }

  // A WebSocket by hand, so the status of a refused connection can be seen.
  ws(pathname, cookie, extra = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13", ...extra };
      if (cookie) headers.Cookie = cookie;
      const opts = { host: this.url.hostname, port: this.url.port || (this.https ? 443 : 80), path: pathname, headers, timeout: 30000 };
      const ip = cli.pinned[this.url.hostname];
      if (ip) opts.lookup = (_h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
      const req = (this.https ? https : http).request(opts);
      req.on("upgrade", (res, socket, head) => resolve(new Socket(res.statusCode, socket, head)));
      req.on("response", (res) => {
        res.resume();
        resolve(new Socket(res.statusCode, null));
      });
      req.on("error", reject);
      req.end();
    });
  }
}

class Socket {
  constructor(status, socket, head) {
    this.status = status;
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.waiting = null;
    if (socket) {
      socket.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        this.waiting?.();
      });
      socket.on("error", () => {});
    }
  }

  // The next text message, or null if none arrives in time. (Server frames are never masked.)
  async read(timeout = 10000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const frame = this.#frame();
      if (frame && frame.op === 1) return frame.data.toString("utf8");
      if (frame && frame.op === 8) return null;
      if (frame) continue;
      const left = deadline - Date.now();
      if (left <= 0 || !this.socket) return null;
      await new Promise((r) => {
        const t = setTimeout(r, left);
        this.waiting = () => (clearTimeout(t), r());
      });
      this.waiting = null;
    }
  }

  #frame() {
    const b = this.buf;
    if (b.length < 2) return null;
    let n = b[1] & 0x7f;
    let at = 2;
    if (n === 126) {
      if (b.length < 4) return null;
      n = b.readUInt16BE(2);
      at = 4;
    } else if (n === 127) {
      if (b.length < 10) return null;
      n = Number(b.readBigUInt64BE(2));
      at = 10;
    }
    if (b.length < at + n) return null;
    this.buf = b.subarray(at + n);
    return { op: b[0] & 0x0f, data: b.subarray(at, at + n) };
  }

  close() {
    this.socket?.destroy();
  }
}

// The Set-Cookie line for one cookie ("" if it wasn't set), and just its name=value part.
const cookieFrom = (res, name = "boa") => (res.headers["set-cookie"] || []).find((c) => c.startsWith(name + "=")) || "";
const pair = (setCookie) => setCookie.split(";")[0];

async function run(base, token, { quiet = false, log = console.log } = {}) {
  const site = new Site(base, token);
  const failures = [];
  let passed = 0;
  const section = (name) => log(name);
  const check = (label, ok, detail = "") => {
    if (ok) passed++;
    else failures.push(label);
    if (!ok || !quiet) log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || detail === "" ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
  };

  const tag = crypto.randomBytes(3).toString("hex");
  const s1 = `check-${tag}`;
  const s2 = `check-${tag}-b`;
  const s3 = `check-${tag}-c`;
  const s4 = `check-${tag}-d`;
  const pw = `pw-${crypto.randomBytes(8).toString("hex")}`;
  const pw2 = `pw-${crypto.randomBytes(8).toString("hex")}`;
  const made = [s1, s2, s3, s4];
  const admin = (method, p, body) => site.req(method, `/_admin${p}`, { admin: true, body });
  const exported = async (slug = s1) => (await admin("GET", `/apps/${slug}/export`)).json();
  // Use a one-time link as a person does: the Continue button on the page it opens posts its token.
  const pressContinue = (link) => {
    const u = new URL(link, site.base);
    return site.req("POST", u.pathname, { form: { t: u.searchParams.get("t") } });
  };
  const linkPath = (r) => {
    const u = new URL(r.json().url);
    return `${u.pathname}${u.search}`;
  };

  log(`Checking ${site.url.host}: test apps ${s1} and three more like it`);
  try {
    section("the owner's key");
    check("no key -> refused", (await site.req("GET", "/_admin/apps")).status === 401);
    check("'Bearer undefined' -> refused", (await site.req("GET", "/_admin/apps", { headers: { Authorization: "Bearer undefined" } })).status === 401);
    check("wrong key -> refused", (await site.req("GET", "/_admin/apps", { headers: { Authorization: "Bearer nope" } })).status === 401);
    check("new app without a password -> refused", (await admin("PUT", `/apps/${s1}`, { title: "x" })).status === 400);
    check("bad app name -> refused", (await admin("PUT", "/apps/Bad_Name", { password: "x" })).status === 400);
    let r = await admin("GET", "");
    check("the Worker reports its version", r.status === 200 && r.json().version === cli.VERSION, `${r.json().version} here ${cli.VERSION}`);

    section("making an app and its files");
    r = await admin("PUT", `/apps/${s1}`, { title: "Check", password: pw });
    check("create an app", r.status === 200, r.status);
    check("a new app has no closing date", r.json().expires_at === null && r.json().closed === false, r.json());
    await admin("PUT", `/apps/${s2}`, { title: "Check B", password: pw2 });
    const html = Buffer.from("<!doctype html><title>check</title><p>check page</p>");
    const put = (slug, file, body, headers = {}) => site.req("PUT", `/_admin/apps/${slug}/files/${file}`, { admin: true, body, headers });
    check("upload index.html", (await put(s1, "index.html", html, { "Content-Type": "text/html; charset=utf-8" })).status === 200);
    check("upload to a reserved _name -> refused", (await put(s1, "_boa.js", Buffer.from("x"))).status === 400);
    check("upload with .. -> refused", [400, 404].includes((await put(s1, "a/..%2F..%2Fx", Buffer.from("x"))).status));
    check("one piece over 1 MB -> refused", (await put(s1, "toobig.bin", Buffer.alloc(1024 * 1024 + 1))).status === 413);
    // A 2.5 MB file goes up in three pieces and must come back identical (checked after sign-in).
    const big = crypto.randomBytes(2_500_000);
    const md5 = crypto.createHash("md5").update(big).digest("hex");
    const piece = (i, upload = "check-upload-1", parts = 3) =>
      put(s1, "big.bin", big.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024), { "X-Boa-Upload": upload, "X-Boa-Part": String(i), "X-Boa-Parts": String(parts), "X-Boa-Etag": md5 });
    await piece(0);
    await piece(1);
    r = await admin("GET", `/apps/${s1}/files`);
    check("a half-uploaded file isn't visible yet", !r.json().some((f) => f.path === "big.bin"), r.json());
    r = await piece(2);
    check("a file sent in pieces is stored whole", r.status === 200 && r.json().size === big.length && r.json().etag === md5, r.json());
    await put(s1, "gap.bin", Buffer.from("a"), { "X-Boa-Upload": "check-upload-2", "X-Boa-Part": "0", "X-Boa-Parts": "3" });
    r = await put(s1, "gap.bin", Buffer.from("c"), { "X-Boa-Upload": "check-upload-2", "X-Boa-Part": "2", "X-Boa-Parts": "3" });
    check("a file with a piece missing -> refused", r.status === 400, r.status);

    section("who gets in");
    r = await site.req("GET", `/${s1}/`);
    check("the page without signing in shows the password form", r.status === 200 && r.text.includes('name="password"') && !r.text.includes("check page"));
    check("answers without signing in -> refused", (await site.req("GET", `/${s1}/_api/state`)).status === 401);
    r = await site.req("GET", `/${s1}/_boa.js`);
    check("the browser library isn't served without signing in", !(r.headers["content-type"] || "").includes("javascript"));
    check("an address with no app -> not found", (await site.req("GET", "/no-such-app-here/")).status === 404);
    r = await site.req("GET", "/_boa/alpine.js");
    check("Alpine.js comes from boa itself", r.status === 200 && (r.headers["content-type"] || "").includes("javascript") && r.text.length > 20000, r.status);
    r = await site.req("GET", "/_boa/fonts.css");
    const font = await site.req("GET", "/_boa/inter.woff2");
    check("so do the fonts", r.status === 200 && r.text.includes("/_boa/inter.woff2") && font.status === 200 && font.headers["content-type"] === "font/woff2", font.status);
    r = await site.req("POST", `/${s1}/_login`, { form: { password: "wrong" } });
    check("wrong password -> refused", r.status === 401, r.status);
    r = await site.req("POST", `/${s1}/_login`, { form: { password: pw } });
    let raw = cookieFrom(r);
    check("right password -> signed in", r.status === 303 && Boolean(raw), r.status);
    check("the sign-in cookie is for this app only and hidden from scripts",
      raw.includes(`Path=/${s1}/`) && raw.includes("HttpOnly") && (!site.https || raw.includes("Secure")), raw.slice(0, 80));
    let cookie = { Cookie: pair(raw) };

    r = await site.req("GET", `/${s1}/`, { headers: cookie });
    check("signed in: the page is served", r.status === 200 && r.text.includes("check page"), r.status);
    check("pages ask search engines and frames to keep out", (r.headers["x-robots-tag"] || "").startsWith("noindex") && r.headers["x-frame-options"] === "DENY");
    r = await site.req("GET", `/${s1}/big.bin`, { headers: cookie });
    check("the 2.5 MB file comes back identical", r.status === 200 && r.body.equals(big), `${r.status}, ${r.body.length} bytes`);
    await put(s1, "big.bin", Buffer.from("small now"));
    r = await site.req("GET", `/${s1}/big.bin`, { headers: cookie });
    check("replacing a file leaves nothing of the old one", r.text === "small now", r.body.length);
    await admin("DELETE", `/apps/${s1}/files/big.bin`);
    check("a deleted file is gone", (await site.req("GET", `/${s1}/big.bin`, { headers: cookie })).status === 404);
    // Cloudflare can drop ETags from HTML, so test on CSS.
    await put(s1, "app.css", Buffer.from("body{color:red}"), { "Content-Type": "text/css" });
    r = await site.req("GET", `/${s1}/app.css`, { headers: cookie });
    const etag = r.headers.etag;
    check("files are served with an ETag", r.status === 200 && Boolean(etag), `${r.status} etag=${etag}`);
    if (etag) check("an unchanged file isn't sent twice (304)", (await site.req("GET", `/${s1}/app.css`, { headers: { ...cookie, "If-None-Match": etag } })).status === 304);
    check("one app's sign-in is refused by another", (await site.req("GET", `/${s2}/_api/state`, { headers: cookie })).status === 401);
    await put(s2, "secret.html", Buffer.from("other app's file"));
    check("an encoded ../ can't reach another app's files", (await site.req("GET", `/${s1}/..%2F${s2}%2Fsecret.html`, { headers: cookie })).status === 404);
    check("folders aren't listed", (await site.req("GET", `/${s1}/nope/`, { headers: cookie })).status === 404);

    section("answers");
    const save = (key, body, extra = {}) =>
      site.req("PUT", `/${s1}/_api/state/${encodeURIComponent(key)}`, { body, headers: { ...cookie, "X-Boa-Author": "Checker", ...extra } });
    r = await save("A1.choice", { value: "a" });
    check("save an answer", r.status === 200 && r.json().author === "Checker", r.status);
    check("bad key -> refused", (await save("has space", { value: 1 })).status === 400);
    check("missing value -> refused", (await save("A1.x", { nope: 1 })).status === 400);
    check("oversized value -> refused", (await save("A1.big", { value: "x".repeat(70000) })).status === 400);
    r = await site.req("GET", `/${s1}/_api/state`, { headers: cookie });
    check("read the answers back", r.status === 200 && r.json()[0]?.value === "a");

    section("live updates");
    let sock = await site.ws(`/${s1}/_api/live`);
    check("live connection without signing in -> refused", sock.status === 401, sock.status);
    sock.close();
    sock = await site.ws(`/${s1}/_api/live`, cookie.Cookie);
    check("live connection when signed in", sock.status === 101, sock.status);
    const t0 = Date.now();
    await admin("PUT", `/apps/${s1}/state/A2.choice`, { value: "b", author: "Other" });
    let msg = JSON.parse((await sock.read()) || "{}");
    check(`a change reaches open pages (${Date.now() - t0} ms)`, msg.row?.key === "A2.choice", msg);
    sock.close();

    section("one-time links");
    let link = linkPath(await admin("POST", `/apps/${s1}/links`, { name: "Linked" }));
    r = await site.req("GET", link);
    check("opening a link shows Continue and signs nobody in", r.status === 200 && r.text.includes("Continue") && !cookieFrom(r), r.status);
    check("opening it again (a message preview) doesn't use it up", (await site.req("GET", link)).status === 200);
    r = await pressContinue(link);
    check("Continue signs in", r.status === 303 && Boolean(cookieFrom(r)), r.status);
    check("the link carries the visitor's name", cookieFrom(r, "boa_name").startsWith("boa_name=Linked"));
    check("a link works once (second Continue -> expired)", (await pressContinue(link)).status === 410);
    check("a used link opens as expired", (await site.req("GET", link)).status === 410);
    const tampered = link.slice(0, -3) + (link.endsWith("AAA") ? "BBB" : "AAA");
    check("a tampered link -> expired", (await site.req("GET", tampered)).status === 410 && (await pressContinue(tampered)).status === 410);
    const stale = linkPath(await admin("POST", `/apps/${s1}/links`, {}));

    section("open apps (no password)");
    await admin("PUT", `/apps/${s1}`, { open: true });
    r = await site.req("GET", `/${s1}/`);
    check("open: the page without signing in", r.status === 200 && r.text.includes("check page"), r.status);
    r = await site.req("GET", `/${s1}/_boa.js`);
    check("open: the browser library without signing in", r.status === 200 && (r.headers["content-type"] || "").includes("javascript"), r.status);
    check("open: answers without signing in", (await site.req("GET", `/${s1}/_api/state`)).status === 200);
    check("open: saving without signing in", (await site.req("PUT", `/${s1}/_api/state/O1.x`, { body: { value: 1 }, headers: { "X-Boa-Author": "Anon" } })).status === 200);
    sock = await site.ws(`/${s1}/_api/live`);
    check("open: live connection without signing in", sock.status === 101, sock.status);
    sock.close();
    check("open: the password form just leads to the page", (await site.req("POST", `/${s1}/_login`, { form: { password: "x" } })).status === 303);
    check("open: search engines still kept out", ((await site.req("GET", `/${s1}/`)).headers["x-robots-tag"] || "").startsWith("noindex"));
    check("other apps still need their password", (await site.req("GET", `/${s2}/_api/state`)).status === 401);
    check("the app's details say it is open", (await admin("GET", `/apps/${s1}`)).json().open === true);
    await admin("PUT", `/apps/${s1}`, { open: false });
    check("password back on: answers without signing in -> refused", (await site.req("GET", `/${s1}/_api/state`)).status === 401);
    check("password back on: earlier sign-ins still work", (await site.req("GET", `/${s1}/_api/state`, { headers: cookie })).status === 200);

    section("private answers");
    await admin("PUT", `/apps/${s1}`, { private: true });
    const sess = cookie.Cookie;
    // A new browser: signed in, but with no visitor cookie yet.
    const newVisitor = async () => {
      const res = await site.req("GET", `/${s1}/`, { headers: { Cookie: sess } });
      const v = pair(cookieFrom(res, "boa_v"));
      return { status: res.status, v, jar: { Cookie: `${sess}; ${v}` } };
    };
    const a = await newVisitor();
    check("a first visit gives the browser its own visitor cookie", a.status === 200 && a.v.length > 10, a.status);
    const b = await newVisitor();
    check("each browser is its own visitor", b.v.length > 10 && a.v !== b.v);
    const psave = (jar, key, value, who) => site.req("PUT", `/${s1}/_api/state/${key}`, { body: { value }, headers: { ...jar, "X-Boa-Author": who } });
    const state = async (jar) => Object.fromEntries((await site.req("GET", `/${s1}/_api/state`, { headers: jar })).json().map((row) => [row.key, row.value]));
    check("visitor A saves", (await psave(a.jar, "P1.x", "from A", "A")).status === 200);
    check("visitor B saves the same question", (await psave(b.jar, "P1.x", "from B", "B")).status === 200);
    const sa = await state(a.jar);
    const sb = await state(b.jar);
    check("A sees only A's answers (and none of the shared ones)", JSON.stringify(sa) === JSON.stringify({ "P1.x": "from A" }), sa);
    check("B sees only B's answers", JSON.stringify(sb) === JSON.stringify({ "P1.x": "from B" }), sb);
    r = await site.req("GET", `/${s1}/_api/state`, { headers: { Cookie: `${sess}; ${a.v.slice(0, -3)}xyz` } });
    check("a tampered visitor cookie -> a fresh, empty visitor", r.status === 200 && r.text.trim() === "[]" && Boolean(cookieFrom(r, "boa_v")));
    let info = (await site.req("GET", `/${s1}/_api/info`, { headers: a.jar })).json();
    check("visitors aren't told how many others there are", info.private === true && !("visitors" in info) && !("answers" in info), info);
    let x = await exported();
    const ids = Object.fromEntries(x.private_state.map((row) => [row.author, row.visitor]));
    check("the owner's export has each visitor's answers", Object.keys(ids).sort().join() === "A,B" && x.info.visitors === 2, x.private_state);
    check("live connection without a visitor cookie -> refused", (await site.ws(`/${s1}/_api/live`, sess)).status === 401);
    const sockA = await site.ws(`/${s1}/_api/live`, a.jar.Cookie);
    const sockB = await site.ws(`/${s1}/_api/live`, b.jar.Cookie, { "X-Boa-Visitor": ids.A || "" });
    check("each visitor's live connection opens", sockA.status === 101 && sockB.status === 101, [sockA.status, sockB.status]);
    await psave(a.jar, "P2.x", "live A", "A");
    msg = JSON.parse((await sockA.read()) || "{}");
    check("A's change reaches A's own pages", msg.row?.key === "P2.x", msg);
    const leaked = await sockB.read(2000);
    check("A's change does not reach B (even claiming to be A)", leaked === null, leaked);
    sockA.close();
    sockB.close();
    check("owner's write without naming a visitor -> refused", (await admin("PUT", `/apps/${s1}/state/P3.x`, { value: 1 })).status === 400);
    r = await admin("PUT", `/apps/${s1}/state/P3.x`, { value: "hi A", visitor: ids.A });
    check("owner's write to one visitor reaches only them", r.status === 200 && (await state(a.jar))["P3.x"] === "hi A" && !("P3.x" in (await state(b.jar))));
    r = await pressContinue(linkPath(await admin("POST", `/apps/${s1}/links`, { visitor: ids.A })));
    const jarC = { Cookie: `${pair(cookieFrom(r))}; ${pair(cookieFrom(r, "boa_v"))}` };
    check("a visitor's link opens their answers in another browser", r.status === 303 && (await state(jarC))["P1.x"] === "from A");

    section("visits");
    x = await exported();
    let vis = Object.fromEntries(x.visits.map((v) => [v.visitor, v]));
    check("loading answers records a visit, named from what they saved", vis[ids.A]?.name === "A", x.visits);
    const before = vis[ids.A]?.visits;
    await site.req("GET", `/${s1}/_api/state`, {
      headers: { ...a.jar, "X-Boa-Author": "Anna", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
    });
    x = await exported();
    const rowA = x.visits.find((v) => v.visitor === ids.A) || {};
    check("a reload within 30 minutes is the same visit", rowA.visits === before, rowA);
    check("a visit records the name sent and the kind of device", rowA.name === "Anna" && rowA.device === "Safari on iPhone", rowA);
    const count = x.visits.length;
    await site.req("GET", `/${s1}/`, { headers: { Cookie: sess, "User-Agent": "WhatsApp/2.23.20.0" } });
    check("a message preview (page only, no answers loaded) is not a visit", (await exported()).visits.length === count);
    info = (await site.req("GET", `/${s1}/_api/info`, { headers: a.jar })).json();
    check("visitors aren't told how many have visited", !("visited" in info), info);

    section("merging one person's two browsers");
    const e = await newVisitor();
    const d = await newVisitor();
    await psave(e.jar, "M1.x", "from E", "Eve");
    await psave(e.jar, "M2.e", "only E", "Eve");
    await sleep(5);
    await psave(d.jar, "M1.x", "from D", "Eve"); // newer, so it should win
    await psave(d.jar, "M3.d", "only D", "Eve");
    await state(d.jar);
    await state(e.jar);
    x = await exported();
    const idE = x.private_state.find((row) => row.key === "M2.e")?.visitor;
    const idD = x.private_state.find((row) => row.key === "M3.d")?.visitor;
    const visitsBefore = Object.fromEntries(x.visits.map((v) => [v.visitor, v.visits]));
    const sockD = await site.ws(`/${s1}/_api/live`, d.jar.Cookie);
    r = await admin("POST", `/apps/${s1}/visitors/merge`, { from: idD, into: idE });
    check("merge two visitors", r.status === 200 && r.json().answers === 3, [r.status, r.text]);
    const want = JSON.stringify({ "M1.x": "from D", "M2.e": "only E", "M3.d": "only D" });
    check("the merged visitor has both sets of answers (the newer wins)", JSON.stringify(await state(e.jar)) === want, await state(e.jar));
    check("the other browser sees the merged answers", JSON.stringify(await state(d.jar)) === want, await state(d.jar));
    await psave(d.jar, "M4.d", "after merge", "Eve");
    check("the other browser's saves land in the merged visitor", (await state(e.jar))["M4.d"] === "after merge");
    x = await exported();
    check("the old id is gone from answers and visits", ![...x.private_state, ...x.visits].some((row) => row.visitor === idD));
    const rowE = x.visits.find((v) => v.visitor === idE) || {};
    check("their visits are added together", rowE.visits === (visitsBefore[idE] || 0) + (visitsBefore[idD] || 0), rowE);
    check("history follows the merge", !x.history.some((h) => h.visitor === idD));
    check("the export lists the merge", (x.merged || []).some((m) => m.visitor === idD && m.target === idE), x.merged);
    check("merging the same two again -> refused", (await admin("POST", `/apps/${s1}/visitors/merge`, { from: idD, into: idE })).status === 400);
    msg = JSON.parse((await sockD.read()) || "{}");
    check("the other browser's open page is told to reload", msg.type === "reset", msg);
    sockD.close();

    await admin("PUT", `/apps/${s1}`, { open: true });
    r = await site.req("GET", `/${s1}/_api/state`);
    check("open and private: a stranger gets empty answers and a visitor cookie", r.status === 200 && r.text.trim() === "[]" && Boolean(cookieFrom(r, "boa_v")));
    check("open and private: a visitor still sees only their own", (await state({ Cookie: a.v }))["P1.x"] === "from A");
    await admin("PUT", `/apps/${s1}`, { open: false, private: false });
    const shared = await state(a.jar);
    check("private off -> the shared answers again", "A1.choice" in shared && !("P1.x" in shared));
    const nVisits = (await exported()).visits.length;
    await state(b.jar);
    check("shared apps record no visits", (await exported()).visits.length === nVisits);

    section("sign-ups: limited places");
    r = await admin("PUT", `/apps/${s3}`, { title: "Check sign-up", password: pw, open: true, private: true, limits: { yoga: 2, solo: 1 } });
    check("create a sign-up app with limits", r.status === 200 && r.json().limits?.yoga?.left === 2, r.json());
    check("a limit needs a whole number of places", (await admin("PUT", `/apps/${s3}`, { limits: { yoga: "lots" } })).status === 400);
    // A new browser on an open app: its first request hands it a visitor cookie.
    const fresh = async (slug = s3) => ({ Cookie: pair(cookieFrom(await site.req("GET", `/${slug}/_api/info`), "boa_v")) });
    const book = (jar, limit, details, slug = s3) => site.req("POST", `/${slug}/_api/book/${limit}`, { body: details, headers: jar });
    const cancel = (jar, limit, slug = s3) => site.req("DELETE", `/${slug}/_api/book/${limit}`, { headers: jar });
    const mine = async (jar, slug = s3) => (await site.req("GET", `/${slug}/_api/bookings`, { headers: jar })).json();
    const places = async (slug = s3) => (await site.req("GET", `/${slug}/_api/info`)).json().limits;
    const ann = await fresh();
    const bob = await fresh();
    const bobSock = await site.ws(`/${s3}/_api/live`, bob.Cookie);
    r = await book(ann, "yoga", { name: "Ann", email: "ann@example.com", note: "First time" });
    check("book a place", r.status === 200 && r.json().booking?.name === "Ann" && r.json().limits?.yoga?.left === 1, [r.status, r.text.slice(0, 120)]);
    const annLink = r.json().link || "";
    check("booking gives a private link for changing or cancelling", annLink.includes(`/${s3}/_mine?t=`), annLink.slice(0, 60));
    msg = JSON.parse((await bobSock.read()) || "{}");
    check("everyone's page hears that a place has gone", msg.type === "places" && msg.limits?.yoga?.left === 1, msg);
    bobSock.close();
    check("the booker sees their own booking", (await mine(ann)).bookings?.[0]?.email === "ann@example.com");
    const bobView = await mine(bob);
    check("nobody else sees it, only how many places are left", bobView.bookings?.length === 0 && bobView.link === null && (await places()).yoga.left === 1, bobView);
    info = (await site.req("GET", `/${s3}/_api/info`, { headers: bob })).json();
    check("visitors aren't told how many bookings there are, or who made them", !("bookings" in info) && !JSON.stringify(info).includes("Ann"), info);
    check("booking without a name -> refused", (await book(bob, "yoga", { email: "bob@example.com" })).status === 400);
    check("booking with a bad email address -> refused", (await book(bob, "yoga", { name: "Bob", email: "not-an-address" })).status === 400);
    check("booking something that doesn't exist -> refused", (await book(bob, "pilates", { name: "Bob" })).status === 404);
    r = await book(bob, "yoga", { name: "Bot", email: "bot@example.com", trap: "http://spam.example" });
    check("the hidden field only bots fill in -> refused, and no place taken", r.status === 400 && (await places()).yoga.left === 1, r.status);
    r = await book(ann, "yoga", { name: "Ann Lee", email: "ann@example.com" });
    check("booking again changes the details and takes no second place", r.status === 200 && r.json().booking?.name === "Ann Lee" && (await places()).yoga.taken === 1, r.text.slice(0, 120));
    check("a visitor can't write over booking records", (await site.req("PUT", `/${s3}/_api/state/${encodeURIComponent("booking:yoga")}`, { body: { value: 1 }, headers: ann })).status === 400);

    // Eight people go for the one place at the same moment.
    const racers = await Promise.all(Array.from({ length: 8 }, () => fresh()));
    const results = await Promise.all(racers.map((jar, i) => book(jar, "solo", { name: `Racer ${i}` })));
    const won = results.filter((res) => res.status === 200).length;
    const full = results.filter((res) => res.status === 409).length;
    check("eight people racing for the last place: exactly one gets it", won === 1 && full === 7 && (await places()).solo.taken === 1, results.map((res) => res.status));

    r = await site.req("GET", new URL(annLink).pathname + new URL(annLink).search);
    check("opening the private link shows Continue and changes nothing", r.status === 200 && r.text.includes("Continue") && !cookieFrom(r, "boa_v"), r.status);
    r = await site.req("POST", `/${s3}/_mine`, { form: { t: new URL(annLink).searchParams.get("t") } });
    const annPhone = { Cookie: pair(cookieFrom(r, "boa_v")) };
    check("Continue opens that booking on another device", r.status === 303 && (await mine(annPhone)).bookings?.[0]?.name === "Ann Lee", r.status);
    check("a tampered private link -> expired", (await site.req("POST", `/${s3}/_mine`, { form: { t: new URL(annLink).searchParams.get("t").slice(0, -3) + "AAA" } })).status === 410);

    x = await exported(s3);
    const annBooking = x.bookings.find((bk) => bk.name === "Ann Lee");
    check("the owner's export lists every booking with its number", x.bookings.length === 2 && annBooking?.id > 0 && annBooking.limit === "yoga", x.bookings);
    check("history records each booking and change", x.history.filter((h) => h.key === "booking:yoga").map((h) => h.value.event).join() === "booked,changed", x.history.map((h) => h.key));
    check("removing a limit that has bookings -> refused", (await admin("PUT", `/apps/${s3}`, { limits: { yoga: null } })).status === 400);
    await admin("PUT", `/apps/${s3}`, { limits: { yoga: 1 } });
    check("fewer places than bookings: nobody loses theirs, none are left", (await places()).yoga.left === 0 && (await book(bob, "yoga", { name: "Bob" })).status === 409);
    await admin("PUT", `/apps/${s3}`, { limits: { yoga: 2 } });
    const annSock = await site.ws(`/${s3}/_api/live`, ann.Cookie);
    r = await admin("DELETE", `/apps/${s3}/bookings/${annBooking?.id}`);
    check("the owner removes a booking", r.status === 200 && r.json().removed?.name === "Ann Lee" && (await places()).yoga.left === 2, r.text.slice(0, 120));
    const heard = [JSON.parse((await annSock.read()) || "{}").type, JSON.parse((await annSock.read()) || "{}").type];
    check("the booker's open page hears it has gone", heard.includes("bookings") && (await mine(ann)).bookings.length === 0, heard);
    annSock.close();
    check("removing a booking that isn't there -> not found", (await admin("DELETE", `/apps/${s3}/bookings/999999`)).status === 404);
    await book(bob, "yoga", { name: "Bob" });
    check("cancel a booking", (await cancel(bob, "yoga")).status === 200 && (await places()).yoga.left === 2);
    check("cancelling twice -> nothing to cancel", (await cancel(bob, "yoga")).status === 404);
    await book(bob, "yoga", { name: "Bob" });
    await admin("PUT", `/apps/${s3}`, { closed: true });
    check("closed: no booking or cancelling", (await book(ann, "yoga", { name: "Ann" })).status === 423 && (await cancel(bob, "yoga")).status === 423);
    await admin("PUT", `/apps/${s3}`, { closed: false });
    await admin("DELETE", `/apps/${s3}/state`);
    x = await exported(s3);
    check("reset clears the bookings and keeps the limits", x.bookings.length === 0 && x.info.limits.yoga.left === 2 && x.info.limits.solo.left === 1, x.info.limits);

    section("sign-ups: holding back floods");
    await admin("PUT", `/apps/${s4}`, { title: "Check flood", password: pw, open: true, limits: { hall: 30 } });
    let accepted = 0;
    for (let i = 0; i < 20; i++) if ((await book(await fresh(s4), "hall", { name: `Guest ${i}` }, s4)).status === 200) accepted++;
    r = await book(await fresh(s4), "hall", { name: "Guest 21" }, s4);
    check("one internet address can make 20 bookings a day on an app, not 21", accepted === 20 && r.status === 429 && (await places(s4)).hall.taken === 20, [accepted, r.status]);
    const eager = await fresh(s4);
    const burst = await Promise.all(Array.from({ length: 70 }, (_, i) =>
      site.req("PUT", `/${s4}/_api/state/flood.${i}`, { body: { value: i }, headers: { ...eager, "X-Boa-Author": "Eager" } })));
    const slowed = burst.filter((res) => res.status === 429).length;
    check("70 saves at once from one visitor: the first 60 land, the rest are told to slow down", slowed === 10 && burst.filter((res) => res.status === 200).length === 60, burst.map((res) => res.status).join(" ").slice(0, 80));

    section("changing the password");
    await admin("PUT", `/apps/${s1}`, { password: `${pw}-new` });
    check("everyone signed in is signed out", (await site.req("GET", `/${s1}/_api/state`, { headers: cookie })).status === 401);
    check("a link made before the change is dead", (await site.req("GET", stale)).status === 410);
    r = await site.req("POST", `/${s1}/_login`, { form: { password: `${pw}-new` } });
    cookie = { Cookie: pair(cookieFrom(r)) };

    section("closing and reopening");
    await admin("PUT", `/apps/${s1}`, { closed: true });
    check("closed: a visitor can't save", (await save("A1.choice", { value: "b" })).status === 423);
    check("closed: still readable", (await site.req("GET", `/${s1}/`, { headers: cookie })).status === 200);
    check("closed: the owner can still write", (await admin("PUT", `/apps/${s1}/state/A3.note`, { value: "from the owner" })).status === 200);
    await admin("PUT", `/apps/${s1}`, { closed: false });
    check("reopened: saving works again", (await save("A1.choice", { value: "c" })).status === 200);
    await admin("PUT", `/apps/${s1}`, { expires_at: "2000-01-01T00:00:00Z" });
    check("past its closing date: read-only", (await save("A1.choice", { value: "d" })).status === 423);
    await admin("PUT", `/apps/${s1}`, { expires_at: null });
    check("closing date removed: saving works again", (await save("A1.choice", { value: "e" })).status === 200);

    section("export and reset");
    r = await admin("GET", `/apps/${s1}/export`);
    x = r.json();
    check("the export has the answers and the full history", r.status === 200 && x.history.length >= 4 && x.state.length >= 2, `${(x.history || []).length} history rows`);
    check("no password hash in the export or the app's details", !/pw_hash|pbkdf2/.test(r.text) && !/pw_hash|pbkdf2/.test((await admin("GET", `/apps/${s1}`)).text));
    r = await admin("DELETE", `/apps/${s1}/state`);
    x = await exported();
    check("reset clears answers, history and visits", r.status === 200 && !x.state.length && !x.private_state.length && !x.history.length && !x.visits.length, x);
    check("reset keeps the files and settings", (await site.req("GET", `/${s1}/`, { headers: cookie })).text.includes("check page"));

    section("locking out password guessers (10 wrong tries, about 8 seconds)");
    for (let i = 0; i < 10; i++) await site.req("POST", `/${s2}/_login`, { form: { password: "guess" } });
    check("the 11th wrong try is locked out", (await site.req("POST", `/${s2}/_login`, { form: { password: "guess" } })).status === 429);
    check("even the right password has to wait", (await site.req("POST", `/${s2}/_login`, { form: { password: pw2 } })).status === 429);
  } catch (e) {
    check(`the checks stopped early: ${e.message}`, false, e.stack?.split("\n")[1]?.trim() || "");
  } finally {
    section("tidying up");
    for (const s of made) {
      const r = await admin("DELETE", `/apps/${s}`).catch((e) => ({ status: 0, text: e.message }));
      check(`delete ${s}`, r.status === 200, r.text.slice(0, 80));
    }
    const gone = await site.req("GET", `/${s1}/`).catch(() => ({ status: 0 }));
    check("a deleted app -> not found", gone.status === 404, gone.status);
    const list = await admin("GET", "/apps").catch(() => ({ text: s1 }));
    check("and it is off the list of apps", !list.text.includes(s1));
  }

  log(failures.length ? `\n${failures.length} of ${passed + failures.length} checks FAILED:\n  - ${failures.join("\n  - ")}` : `\nAll ${passed} checks passed.`);
  return { passed, failures };
}

module.exports = { run, Site, cookieFrom, pair };

if (require.main === module) {
  (async () => {
    const local = process.argv.includes("--local");
    let base, token;
    if (local) {
      base = cli.LOCAL_BASE;
      token = cli.readEnvFile(path.join(cli.WORKER, ".dev.vars")).ADMIN_TOKEN;
    } else {
      const cfg = cli.loadConfig();
      base = process.env.BOA_BASE_URL || cfg.base_url;
      token = process.env.BOA_ADMIN_TOKEN || cfg.admin_token;
    }
    if (!base || !token) {
      console.error(local ? "The local Worker has never been started: run `boa dev` first." : "boa isn't set up on this computer yet: run `boa setup`.");
      process.exit(1);
    }
    const { failures } = await run(base, token);
    process.exit(failures.length ? 1 : 0);
  })();
}
