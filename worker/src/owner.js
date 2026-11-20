// The owner's page for one app, at /<slug>/_owner: every answer and booking, a CSV download, and
// a button to remove a booking. It is reached only by a one-time link from `boa owner`; after that
// the device stays signed in for a year, until `boa owner --signout`.
import { makeToken, readToken } from "./auth.js";
import { BASE_CSS, enterPage, esc, linkExpiredPage, SEC_HEADERS } from "./pages.js";
import { err, getCookie, json, readJson, redirect } from "./visit.js";

const OWNER_DAYS = 365;

// For a spreadsheet. A cell starting with = + - or @ would be run as a formula, so it gets a ' in front.
function csv(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const download = (name, text) =>
  new Response("﻿" + text, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", ...SEC_HEADERS } });

export async function owner(store, env, req, { slug, sub, url, title }) {
  const secret = env.SESSION_SECRET;
  const gen = store.ownerGen();
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  const cookie = (value, maxAge) => `boa_o=${value}; Path=/${slug}/_owner; ${local ? "" : "Secure; "}SameSite=Lax; HttpOnly; Max-Age=${maxAge}`;

  if (sub === "enter") {
    const posted = req.method === "POST";
    const t = posted ? String((await req.formData().catch(() => null))?.get("t") || "") : url.searchParams.get("t");
    const p = await readToken(secret, t, "owner-enter");
    if (!p || p.s !== slug || p.g !== gen) return linkExpiredPage();
    if (!posted) {
      return store.nonceUsed(p.n) ? linkExpiredPage()
        : enterPage(`/${slug}/_owner/enter`, title, t, "This link opens your owner page, where you can see every answer and booking. It works once, then this device stays signed in for a year.");
    }
    if (!store.useNonce(p.n, p.e)) return linkExpiredPage();
    const token = await makeToken(secret, { k: "owner", s: slug, g: gen, e: Date.now() + OWNER_DAYS * 864e5 });
    return redirect(`/${slug}/_owner`, [cookie(token, OWNER_DAYS * 86400)]);
  }

  const p = await readToken(secret, getCookie(req, "boa_o"), "owner");
  if (!(p && p.s === slug && p.g === gen)) return sub ? err("unauthorised", 401) : signedOutPage(title);

  if (!sub && req.method === "GET") return ownerPage(slug, title);
  if (sub === "data" && req.method === "GET") {
    const { history, merged, ...x } = store.exportAll(false);
    return json({ slug, address: `${url.origin}/${slug}/`, changes: store.historyCount(), ...x });
  }
  if (sub === "bookings.csv" && req.method === "GET") {
    const x = store.exportAll(false);
    return download(`${slug}-bookings.csv`, csv([["what", "name", "email", "note", "booked at"], ...x.bookings.map((b) => [b.limit, b.name, b.email, b.note, b.at])]));
  }
  if (sub === "answers.csv" && req.method === "GET") {
    const x = store.exportAll(false);
    if (!x.info.private) return download(`${slug}-answers.csv`, csv([["question", "answer", "who", "when"], ...x.state.map((r) => [r.key, r.value, r.author, r.at])]));
    const names = Object.fromEntries(x.visits.map((v) => [v.visitor, v.name]));
    return download(`${slug}-answers.csv`, csv([["visitor", "name", "question", "answer", "when"], ...x.private_state.map((r) => [r.visitor.slice(0, 8), names[r.visitor] || r.author, r.key, r.value, r.at])]));
  }
  if (req.method === "POST") {
    // Changes must come from the owner page itself, not from a form on some other website.
    if (req.headers.get("Origin") !== url.origin) return err("this must come from the owner page", 403);
    if (sub === "unbook") {
      const body = (await readJson(req)) || {};
      const result = store.unbook(Number(body.id));
      return result.error ? err(result.error, 404) : json(result);
    }
    if (sub === "signout") return new Response(null, { status: 204, headers: { "Set-Cookie": cookie("", 0), ...SEC_HEADERS } });
  }
  return err("not found", 404);
}

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · owner</title>
<link rel="stylesheet" href="/_boa/fonts.css">
<style>${BASE_CSS}
  main{max-width:56rem;margin:0 auto;padding:1.5rem 1rem 3rem}
  h1{font-size:1.75rem} h2{font-family:'Gowun Batang',Georgia,serif;font-weight:400;font-size:1.25rem;margin:0}
  p{margin:.4rem 0;line-height:1.5} .muted{color:#6b6259;font-size:.875rem}
  a{color:#b4462b} .card{padding:1.1rem 1.25rem;margin-top:1rem}
  .row{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;justify-content:space-between}
  .chip{display:inline-block;background:#f5f0ea;border-radius:999px;padding:.15rem .6rem;font-size:.75rem;margin:.15rem .25rem .15rem 0}
  button,.btn{font:inherit;font-size:.8125rem;font-weight:600;border:0;border-radius:9px;padding:.45rem .8rem;cursor:pointer;background:#2B2B2B;color:#fff;text-decoration:none;display:inline-block}
  button.quiet,.btn.quiet{background:#f5f0ea;color:#2B2B2B} button.danger{background:#fff;color:#b4412b;outline:1px solid #e7c3ba}
  table{width:100%;border-collapse:collapse;margin-top:.6rem;font-size:.875rem}
  th{text-align:left;font-size:.6875rem;letter-spacing:.04em;text-transform:uppercase;color:#8a8178;font-weight:600;padding:.3rem .5rem .3rem 0}
  td{padding:.5rem .5rem .5rem 0;border-top:1px solid #efe9e1;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}
  td.act{text-align:right;white-space:nowrap;padding-right:0}
  .empty{color:#8a8178;font-size:.875rem;margin-top:.5rem}
  @media (max-width:640px){
    thead{display:none} table,tbody,tr,td{display:block}
    tr{border-top:1px solid #efe9e1;padding:.55rem 0} td{border:0;padding:.1rem 0}
    td[data-label]::before{content:attr(data-label) ": ";color:#8a8178;font-size:.75rem}
    td.main{font-weight:600} td.main::before{content:none} td.act{text-align:left;padding-top:.4rem} td:empty{display:none}
  }
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS } });
}

const signedOutPage = (title) =>
  page(title, `<div class="card" style="max-width:24rem;margin:4rem auto"><h1>${esc(title)}</h1>
<p class="muted">This page is for the app's owner, and this device isn't signed in to it. If it's your app, ask Claude for a new owner link.</p></div>`, 401);

// The page is a shell; its script fetches the data and builds everything with textContent, so
// nothing a visitor typed can ever run as HTML.
function ownerPage(slug, title) {
  return page(title, `
<header>
  <p class="muted">Owner page · only you can see this</p>
  <h1>${esc(title)}</h1>
  <p id="chips"></p>
  <div class="row"><p class="muted" id="stamp">Loading…</p>
    <span><a class="btn quiet" id="visit" href="/${esc(slug)}/">Open the page</a> <button id="refresh">Refresh</button></span></div>
</header>
<p id="error" class="err" role="alert" hidden></p>
<div id="bookings"></div>
<div id="answers"></div>
<p class="muted" style="margin-top:2rem">This device stays signed in for a year. <button class="quiet" id="signout">Sign out on this device</button></p>
<script>
(() => {
  const base = ${JSON.stringify(`/${slug}/_owner`)};
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, kids = []) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of [].concat(kids)) n.append(k);
    return n;
  };
  const when = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const show = (v) => typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : JSON.stringify(v);
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const cell = (label, text, cls) => { const td = el("td", { textContent: text ?? "" }); td.dataset.label = label; if (cls) td.className = cls; return td; };
  const table = (heads, rows) => el("table", {}, [el("thead", {}, el("tr", {}, heads.map((h) => el("th", { textContent: h })))), el("tbody", {}, rows)]);
  const fail = (msg) => { $("error").textContent = msg; $("error").hidden = false; };

  async function load() {
    const r = await fetch(base + "/data", { credentials: "same-origin" });
    if (r.status === 401) return location.reload();
    if (!r.ok) return fail("Couldn't load the latest answers. Try Refresh.");
    $("error").hidden = true;
    draw(await r.json());
  }

  function draw(x) {
    const i = x.info;
    $("chips").replaceChildren(...[
      i.closed ? "Closed: nothing can be changed" : i.expires_at ? "Open until " + when(i.expires_at) : "Open for answers",
      i.open ? "No password" : "Password needed",
      i.private ? "Private: each visitor sees only their own answers" : "Shared: everyone sees every answer",
    ].map((t) => el("span", { className: "chip", textContent: t })));
    $("stamp").textContent = "Up to date at " + new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " · " + plural(x.changes, "change") + " so far";

    const limits = Object.entries(i.limits || {});
    const b = $("bookings");
    b.replaceChildren();
    if (limits.length) {
      b.append(el("div", { className: "row", style: "margin-top:1.5rem" }, [el("h2", { textContent: "Bookings" }), el("a", { className: "btn quiet", href: base + "/bookings.csv", textContent: "Download as a spreadsheet" })]));
      for (const [name, l] of limits) {
        const rows = x.bookings.filter((bk) => bk.limit === name).map((bk) => el("tr", {}, [
          cell("Name", bk.name, "main"), cell("Email", bk.email), cell("Note", bk.note), cell("Booked", when(bk.at)),
          el("td", { className: "act" }, el("button", { className: "danger", textContent: "Remove", onclick: () => unbook(bk) })),
        ]));
        b.append(el("section", { className: "card" }, [
          el("div", { className: "row" }, [el("strong", { textContent: name }), el("span", { className: "muted", textContent: l.taken + " of " + l.places + " taken, " + l.left + " left" })]),
          rows.length ? table(["Name", "Email", "Note", "Booked", ""], rows) : el("p", { className: "empty", textContent: "Nobody has booked yet." }),
        ]));
      }
    }

    const a = $("answers");
    a.replaceChildren();
    const hasAnswers = x.state.length || x.private_state.length || x.visits.length;
    if (!hasAnswers && limits.length) return;
    a.append(el("div", { className: "row", style: "margin-top:1.5rem" }, [el("h2", { textContent: "Answers" }), hasAnswers ? el("a", { className: "btn quiet", href: base + "/answers.csv", textContent: "Download as a spreadsheet" }) : ""]));
    if (!hasAnswers) return a.append(el("section", { className: "card" }, el("p", { className: "empty", textContent: "No answers yet." })));
    if (!i.private) {
      a.append(el("section", { className: "card" }, table(["Question", "Answer", "Who", "When"], x.state.map((r) => el("tr", {}, [
        cell("Question", r.key, "main"), cell("Answer", show(r.value)), cell("Who", r.author), cell("When", when(r.at))])))));
      return;
    }
    const visits = Object.fromEntries(x.visits.map((v) => [v.visitor, v]));
    const ids = [...new Set([...x.visits.map((v) => v.visitor), ...x.private_state.map((r) => r.visitor)])];
    for (const id of ids) {
      const rows = x.private_state.filter((r) => r.visitor === id);
      const v = visits[id];
      const name = (v && v.name) || (rows[0] && rows[0].author) || "No name yet";
      const about = [v && v.device, v && plural(v.visits, "visit"), v && "last here " + when(v.last_at), plural(rows.length, "answer")].filter(Boolean).join(" · ");
      a.append(el("section", { className: "card" }, [
        el("div", { className: "row" }, [el("strong", { textContent: name }), el("span", { className: "muted", textContent: about })]),
        rows.length ? table(["Question", "Answer", "When"], rows.map((r) => el("tr", {}, [cell("Question", r.key, "main"), cell("Answer", show(r.value)), cell("When", when(r.at))])))
          : el("p", { className: "empty", textContent: "Has opened the page but not answered yet." }),
      ]));
    }
  }

  async function unbook(bk) {
    if (!confirm("Remove " + bk.name + "'s booking for " + bk.limit + "? They won't be told, so let them know yourself.")) return;
    const r = await fetch(base + "/unbook", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: bk.id }) });
    if (!r.ok && r.status !== 404) fail("Couldn't remove that booking. Try again.");
    load();
  }

  $("refresh").onclick = load;
  $("signout").onclick = async () => { await fetch(base + "/signout", { method: "POST", credentials: "same-origin" }); location.reload(); };
  load().catch(() => fail("Couldn't load the answers. Check your connection and try Refresh."));
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(() => {}); });
})();
</script>`);
}
