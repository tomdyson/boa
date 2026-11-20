// boa.js — shared state for a boa app. Served at /<app>/_boa.js.
// Load it with a plain <script> BEFORE Alpine's deferred script, so the store registers on alpine:init.
(() => {
  // <script src="_boa.js" data-name="later"> stops the page asking for a name as soon as it opens.
  const askLater = document.currentScript?.dataset.name === "later";
  const slug = location.pathname.split("/")[1];
  const base = `/${slug}/_api`;
  const NAME_KEY = "boa_author";
  const remember = {
    get: () => { try { return localStorage.getItem(NAME_KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(NAME_KEY, v); } catch {} },
  };

  // A personal entry link (boa link --as NAME) leaves the name in a short-lived cookie.
  const linkName = decodeURIComponent((document.cookie.match(/(?:^|;\s*)boa_name=([^;]*)/) || [])[1] || "");
  if (linkName) {
    remember.set(linkName);
    document.cookie = `boa_name=; Path=/${slug}/; Max-Age=0; Secure; SameSite=Lax`;
  }
  let name = remember.get();
  let isPrivate = false;

  // --- name dialog (inline styles, so it works whatever CSS the page has) ---------------------
  const css = document.createElement("style");
  css.textContent = `dialog.boa-dialog::backdrop{background:rgba(43,43,43,.4)}
    dialog.boa-dialog input:focus{outline:2px solid #E76F51;border-color:transparent}`;
  document.head.appendChild(css);

  function askName(current) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "boa-dialog";
      d.setAttribute("aria-labelledby", "boa-name-title");
      // margin:auto centres the modal; Tailwind's preflight resets the browser's own centring.
      d.style.cssText = "margin:auto;border:0;border-radius:18px;padding:1.75rem;width:min(22rem,calc(100vw - 2rem));box-sizing:border-box;" +
        "box-shadow:0 20px 50px -12px rgba(0,0,0,.35);font-family:Inter,system-ui,sans-serif;color:#2B2B2B";
      const field = "font:inherit;width:100%;box-sizing:border-box;padding:.65rem .85rem;border-radius:10px;";
      d.innerHTML = `<form method="dialog" style="margin:0">
        <h2 id="boa-name-title" style="font-family:'Gowun Batang',Georgia,serif;font-weight:400;font-size:1.35rem;margin:0 0 .4rem">What's your name?</h2>
        <p style="margin:0 0 1rem;font-size:.9rem;line-height:1.45;color:#6b6259">${isPrivate
          ? "It goes with your answers, so the person who sent you this page knows whose they are."
          : "It appears next to your answers, so everyone can see who said what."}</p>
        <input name="n" required maxlength="80" autocomplete="name" style="${field}border:1px solid #d9d1c7;margin-bottom:.8rem">
        <button style="${field}border:0;background:#2B2B2B;color:#fff;cursor:pointer">Continue</button></form>`;
      const input = d.querySelector("input");
      input.value = current || "";
      let done = false;
      const finish = (v) => { if (done) return; done = true; d.remove(); resolve(v); };
      // The first time, there's no way out without a name.
      d.addEventListener("cancel", (e) => { if (!current) e.preventDefault(); });
      d.querySelector("form").addEventListener("submit", (e) => {
        const v = input.value.trim();
        if (!v) return e.preventDefault();
        finish(v);
      });
      d.addEventListener("close", () => finish(current));
      document.body.appendChild(d);
      d.showModal();
    });
  }

  let asking = null;
  async function me() {
    if (name) return name;
    asking ??= askName("").then((v) => { name = v; remember.set(v); asking = null; return v; });
    return asking;
  }
  function setName(v) {
    v = String(v || "").trim().slice(0, 80);
    if (v) { name = v; remember.set(v); }
  }
  async function changeName() {
    const v = await askName(name);
    if (v) { name = v; remember.set(v); }
    return name;
  }

  // --- API ----------------------------------------------------------------------------------
  async function call(path, opts = {}) {
    const r = await fetch(base + path, { credentials: "same-origin", ...opts });
    if (r.status === 401) { location.reload(); throw new Error("Signed out"); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const plain = {
        closed: "This page is closed, so nothing can be changed.",
        full: "Sorry, the last place has just gone.",
        "too fast": "That was a lot of changes at once. Wait a few seconds and try again.",
        "too many bookings today": "Too many bookings have come from this connection today. Please try again tomorrow.",
        "not accepted": "Sorry, that didn't go through.",
      };
      throw new Error(plain[body.error] || body.error || `Request failed (${r.status})`);
    }
    return body;
  }

  function ago(iso) {
    if (!iso) return "";
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  const api = {
    slug, ago, me, changeName,
    get name() { return name; },
    info: () => call("/info"),
    // Everything a page needs when it opens: {info, state, bookings, link}.
    // The name (if we have it yet) lets private apps label the visit for the owner.
    async start() {
      const s = await call("/start", name ? { headers: { "X-Boa-Author": encodeURIComponent(name) } } : {});
      return { ...s, state: Object.fromEntries(s.state.map((r) => [r.key, r])), bookings: Object.fromEntries(s.bookings.map((b) => [b.limit, b])) };
    },
    async load() {
      const rows = await call("/state", name ? { headers: { "X-Boa-Author": encodeURIComponent(name) } } : {});
      return Object.fromEntries(rows.map((r) => [r.key, r]));
    },
    // Sign-ups. details: {name, email, note, trap}. Booking again changes the details.
    book: (limit, details) => call(`/book/${encodeURIComponent(limit)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(details) }),
    cancel: (limit) => call(`/book/${encodeURIComponent(limit)}`, { method: "DELETE" }),
    bookings: () => call("/bookings"),
    async set(key, value) {
      const author = await me();
      return call(`/state/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Boa-Author": encodeURIComponent(author) },
        body: JSON.stringify({ value }),
      });
    },
    // onMessage({type: "set", row} | {type: "reset"} | {type: "info"} | {type: "places", limits} | {type: "bookings"});
    // reconnects with backoff.
    subscribe(onMessage) {
      let delay = 1000;
      const connect = () => {
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/live`);
        ws.onopen = () => { delay = 1000; };
        ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
        // 4001: the password or the app's privacy has changed, so everyone comes back through the front door.
        ws.onclose = (e) => (e.code === 4001 ? location.reload() : setTimeout(connect, (delay = Math.min(delay * 2, 30000))));
      };
      connect();
    },
  };
  window.boa = api;

  function showClosedBanner() {
    if (document.getElementById("boa-closed")) return;
    const b = document.createElement("div");
    b.id = "boa-closed";
    b.setAttribute("role", "status");
    b.style.cssText = "position:sticky;top:0;z-index:50;background:#2B2B2B;color:#fff;" +
      "font:500 .875rem/1.4 Inter,system-ui,sans-serif;padding:.6rem 1rem;text-align:center";
    b.textContent = "This page is closed. You can still read it, but nothing can be changed.";
    document.body.prepend(b);
  }

  // --- Alpine integration: $store.boa and x-data="boaText('key')" ------------------------------
  document.addEventListener("alpine:init", () => {
    const Alpine = window.Alpine;
    Alpine.store("boa", {
      ready: false, me: name, info: {}, state: {}, saving: {}, error: null,
      // Sign-ups: this visitor's own bookings by limit name, their private link for changing or
      // cancelling, and the hidden field that only bots fill in (bind it to an input people can't see).
      bookings: {}, mine: null, trap: "",
      get closed() { return Boolean(this.info.closed); },
      left(limit) { return this.info.limits?.[limit]?.left ?? null; },
      places(limit) { return this.info.limits?.[limit]?.places ?? null; },
      full(limit) { return this.left(limit) === 0; },
      booked(limit) { return this.bookings[limit] || null; },
      // details: {name, email, note}. Without a name, uses (or asks for) the visitor's own. True if it worked.
      async book(limit, details = {}) {
        if (this.closed) return false;
        this.saving["book:" + limit] = true;
        this.error = null;
        try {
          const who = (details.name || "").trim() || (await api.me());
          this.applyBookings(await api.book(limit, { ...details, name: who, trap: this.trap }));
          if (!api.name) setName(who);
          this.me = api.name;
          return true;
        } catch (e) {
          this.error = e.message;
          this.refreshPlaces();
          return false;
        } finally {
          this.saving["book:" + limit] = false;
        }
      },
      async cancel(limit) {
        if (this.closed) return false;
        this.saving["book:" + limit] = true;
        this.error = null;
        try {
          this.applyBookings(await api.cancel(limit));
          return true;
        } catch (e) {
          this.error = e.message;
          return false;
        } finally {
          this.saving["book:" + limit] = false;
        }
      },
      applyBookings(r) {
        if (r.limits) this.info.limits = r.limits;
        this.bookings = Object.fromEntries((r.bookings || []).map((b) => [b.limit, b]));
        this.mine = r.link || null;
      },
      async refreshPlaces() { try { this.info = await api.info(); } catch {} },
      val(k, fallback) { const r = this.state[k]; return r === undefined ? fallback : r.value; },
      by(k) { return this.state[k]?.author || ""; },
      ago(k) { return ago(this.state[k]?.at); },
      has(k) {
        const v = this.val(k);
        return !(v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length));
      },
      count(keys) { return keys.filter((k) => this.has(k)).length; },
      includes(k, item) { const v = this.val(k); return Array.isArray(v) && v.includes(item); },
      async save(k, v) {
        if (this.closed) return;
        this.saving[k] = true;
        this.error = null;
        try {
          this.state[k] = await api.set(k, v);
          this.me = api.name;
        } catch (e) {
          this.error = e.message;
        } finally {
          this.saving[k] = false;
        }
      },
      // Checklists: the value is an array; toggle one item in or out.
      toggle(k, item) {
        const cur = Array.isArray(this.val(k)) ? [...this.val(k)] : [];
        const i = cur.indexOf(item);
        i >= 0 ? cur.splice(i, 1) : cur.push(item);
        return this.save(k, cur);
      },
      async rename() { this.me = await api.changeName(); },
      async refresh() {
        const s = await api.start();
        this.info = s.info; this.state = s.state; this.bookings = s.bookings; this.mine = s.link;
      },
    });

    // Free text: keeps a local draft while the field has focus, so a colleague's live update
    // can't overwrite what you're typing. Usage:
    //   <textarea x-data="boaText('A1.note')" x-model="draft" x-bind="field"></textarea>
    Alpine.data("boaText", (key) => ({
      key, draft: "", focused: false,
      init() {
        this.draft = this.$store.boa.val(key, "");
        this.$watch(() => this.$store.boa.val(key, ""), (v) => { if (!this.focused) this.draft = v; });
      },
      commit() {
        if (this.draft !== this.$store.boa.val(key, "")) this.$store.boa.save(key, this.draft);
      },
      field: {
        ["@focus"]() { this.focused = true; },
        ["@blur"]() { this.focused = false; this.commit(); },
        ["@input.debounce.800ms"]() { this.commit(); },
        [":disabled"]() { return this.$store.boa.closed; },
      },
    }));
  });

  document.addEventListener("alpine:initialized", async () => {
    const s = window.Alpine.store("boa");
    try {
      await s.refresh();
    } catch (e) {
      s.error = e.message;
      return;
    }
    isPrivate = Boolean(s.info.private);
    s.ready = true;
    if (s.closed) showClosedBanner();
    // A sign-up page asks for a name in its own form, so it isn't asked for at the door.
    else if (!askLater && !Object.keys(s.info.limits || {}).length) {
      const hadName = Boolean(api.name);
      s.me = await api.me();
      // Private apps: reload once the visitor has given their name, so the owner's list of visits shows it.
      if (s.info.private && !hadName && s.me) s.refresh().catch(() => {});
    }
    api.subscribe(async (msg) => {
      if (msg.type === "set") s.state[msg.row.key] = msg.row;
      else if (msg.type === "reset") await s.refresh();
      else if (msg.type === "places") s.info.limits = msg.limits;
      else if (msg.type === "bookings") s.applyBookings(await api.bookings());
      else if (msg.type === "info") {
        s.info = await api.info();
        if (s.closed) showClosedBanner();
      }
    });
    // Catch up on anything missed while the laptop slept.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) s.refresh().catch(() => {}); });
  });
})();
