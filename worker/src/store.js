// Durable Objects. One AppStore per app (named by its slug) holds everything about that app: its
// settings, files, answers, history and live sockets. It also answers visitors' requests itself
// (see visit.js), so one page request costs one Durable Object request. A single Registry lists the apps.
import { DurableObject } from "cloudflare:workers";
import { checkPassword, fingerprint, hashPassword, makeToken } from "./auth.js";
import { LIMITS, VISITOR_DAYS, VISITOR_RE } from "./limits.js";
import { visit } from "./visit.js";

const VISIT_GAP_MS = 30 * 60e3; // loads closer together than this are one visit
const LOCKOUT = { perIp: 10, ipWindowMs: 15 * 60e3, perApp: 200, appWindowMs: 60 * 60e3 };
const STALE_UPLOAD_MS = 60 * 60e3;
// Saves and bookings: at most this many in each ten seconds.
const RATE = { windowMs: 10e3, perVisitor: 60, perIp: 300 };

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class AppStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // An address nobody has made an app at still reaches an object here. It must store nothing,
    // or every stray request to a made-up address would leave an empty database behind.
    this.live = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    if (this.live) this.#schema();
  }

  #schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, author TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, value TEXT, author TEXT, at TEXT, visitor TEXT);
      CREATE TABLE IF NOT EXISTS login_failures (ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS used_nonces (nonce TEXT PRIMARY KEY, exp INTEGER);
      CREATE TABLE IF NOT EXISTS pstate (visitor TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, author TEXT,
                                         at TEXT NOT NULL, PRIMARY KEY (visitor, key));
      CREATE TABLE IF NOT EXISTS visits (visitor TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
                                         visits INTEGER NOT NULL, name TEXT, device TEXT);
      CREATE TABLE IF NOT EXISTS aliases (visitor TEXT PRIMARY KEY, target TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
                                        pieces INTEGER NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_pieces (path TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, seq));
      CREATE TABLE IF NOT EXISTS upload_pieces (upload TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL,
                                                PRIMARY KEY (upload, seq));
      CREATE TABLE IF NOT EXISTS limits (name TEXT PRIMARY KEY, places INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, limit_name TEXT NOT NULL, visitor TEXT NOT NULL,
                                           name TEXT NOT NULL, email TEXT, note TEXT, at TEXT NOT NULL, UNIQUE (limit_name, visitor));
      CREATE TABLE IF NOT EXISTS booking_ips (ip TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    this.live = true;
  }

  #meta() {
    if (!this.live) return {};
    return Object.fromEntries(this.sql.exec("SELECT k, v FROM meta").toArray().map((r) => [r.k, r.v]));
  }

  // A merged visitor's old id (still in a browser cookie somewhere) resolves to the id it was merged into.
  #canon(visitor) {
    if (!visitor) return visitor;
    const row = this.sql.exec("SELECT target FROM aliases WHERE visitor = ?", visitor).toArray()[0];
    return row ? row.target : visitor;
  }

  #isClosed(meta) {
    return meta.closed === "1" || Boolean(meta.expires_at && Date.parse(meta.expires_at) < Date.now());
  }

  // visitor: send only to that visitor's own sockets (private apps). Otherwise to everyone.
  #broadcast(msg, visitor) {
    const text = JSON.stringify(msg);
    for (const ws of visitor ? this.ctx.getWebSockets(visitor) : this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  // What is needed to decide who gets in. Includes the password hash, so it never leaves this object:
  // `exists` is the only part the Worker asks for.
  gate() {
    const m = this.#meta();
    return { exists: Boolean(m.pw_hash), pw_hash: m.pw_hash, title: m.title, closed: this.#isClosed(m), open: m.open === "1", private: m.private === "1" };
  }

  exists() {
    return this.gate().exists;
  }

  info() {
    const { pw_hash, ...m } = this.#meta();
    const priv = m.private === "1";
    const stats = this.sql.exec(`SELECT count(*) AS answers, max(at) AS last_at FROM ${priv ? "pstate" : "state"}`).one();
    const visitors = this.sql.exec("SELECT count(DISTINCT visitor) AS n FROM pstate").one().n;
    const visited = this.sql.exec("SELECT count(*) AS n FROM visits").one().n;
    return {
      title: m.title,
      created_at: m.created_at,
      expires_at: m.expires_at || null,
      closed: this.#isClosed(m),
      closed_manually: m.closed === "1",
      open: m.open === "1",
      private: priv,
      visitors,
      visited,
      answers: stats.answers,
      last_at: stats.last_at,
      limits: this.limitsInfo(),
      bookings: this.sql.exec("SELECT count(*) AS n FROM bookings").one().n,
    };
  }

  // Create or update: {title, password, expires_at, closed, open, private}. A new app needs a
  // password, even an open one: it is what the app falls back to when it stops being open.
  async configure(slug, body) {
    const exists = this.exists();
    if (!exists && !body.password) return { error: "a new app needs a password" };
    const patch = { title: body.title ?? (exists ? undefined : slug) };
    if (body.expires_at !== undefined) {
      if (body.expires_at !== null && Number.isNaN(Date.parse(body.expires_at))) return { error: "bad closing date" };
      patch.expires_at = body.expires_at;
    }
    if (body.password) patch.pw_hash = await hashPassword(String(body.password));
    if (body.closed !== undefined) patch.closed = body.closed ? "1" : null;
    if (body.open !== undefined) patch.open = body.open ? "1" : null;
    if (body.private !== undefined) patch.private = body.private ? "1" : null;
    const limits = Object.entries(body.limits || {});
    for (const [name, places] of limits) {
      if (!LIMITS.limitPattern.test(name)) return { error: `bad limit name "${name}": letters, digits, hyphens, dots and underscores, 60 at most` };
      if (places !== null && !(Number.isInteger(places) && places >= 0 && places <= LIMITS.maxPlaces)) return { error: `"${name}" needs a whole number of places` };
      if (places === null && exists && this.sql.exec("SELECT 1 FROM bookings WHERE limit_name = ? LIMIT 1", name).toArray().length) {
        return { error: `"${name}" still has bookings: remove them first` };
      }
    }
    if (!this.live) this.#schema();
    for (const [name, places] of limits) {
      if (places === null) this.sql.exec("DELETE FROM limits WHERE name = ?", name);
      else this.sql.exec("INSERT OR REPLACE INTO limits VALUES (?, ?)", name, places);
    }
    if (this.sql.exec("SELECT count(*) AS n FROM limits").one().n > LIMITS.maxLimits) return { error: "too many limits in one app" };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) this.sql.exec("DELETE FROM meta WHERE k = ?", k);
      else this.sql.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", k, String(v));
    }
    if (!this.#meta().created_at) this.sql.exec("INSERT INTO meta VALUES ('created_at', ?)", new Date().toISOString());
    this.#broadcast({ type: "info" });
    return this.info();
  }

  // visitor: that visitor's own answers (private apps); otherwise the shared answers.
  getState(visitor) {
    visitor = this.#canon(visitor);
    const rows = visitor
      ? this.sql.exec("SELECT key, value, author, at FROM pstate WHERE visitor = ? ORDER BY key", visitor).toArray()
      : this.sql.exec("SELECT key, value, author, at FROM state ORDER BY key").toArray();
    return rows.map((r) => ({ ...r, value: JSON.parse(r.value) }));
  }

  // force: admin writes go through even when the app is closed. visitor: write to that visitor's
  // private answers, seen and pushed live only to them.
  setState(key, value, author, force = false, visitor = null) {
    if (!force && this.#isClosed(this.#meta())) return { error: "closed" };
    if (!LIMITS.keyPattern.test(key) || key.startsWith("booking:")) return { error: "bad key" };
    if (visitor !== null && !VISITOR_RE.test(visitor)) return { error: "bad visitor" };
    visitor = this.#canon(visitor);
    const v = JSON.stringify(value === undefined ? null : value);
    if (v.length > LIMITS.maxValueBytes) return { error: "value too large" };
    if (visitor) {
      const exists = this.sql.exec("SELECT 1 FROM pstate WHERE visitor = ? AND key = ?", visitor, key).toArray().length > 0;
      if (!exists) {
        if (this.sql.exec("SELECT count(*) AS n FROM pstate WHERE visitor = ?", visitor).one().n >= LIMITS.maxKeysPerVisitor) return { error: "too many keys" };
        if (this.sql.exec("SELECT count(*) AS n FROM pstate").one().n >= LIMITS.maxPrivateRows) return { error: "too many keys" };
      }
    } else {
      const exists = this.sql.exec("SELECT 1 FROM state WHERE key = ?", key).toArray().length > 0;
      if (!exists && this.sql.exec("SELECT count(*) AS n FROM state").one().n >= LIMITS.maxKeys) return { error: "too many keys" };
    }
    const at = new Date().toISOString();
    const who = String(author || "anonymous").slice(0, LIMITS.maxAuthor);
    if (visitor) {
      this.sql.exec("INSERT OR REPLACE INTO pstate VALUES (?, ?, ?, ?, ?)", visitor, key, v, who, at);
      if (!force) this.sql.exec("UPDATE visits SET name = ? WHERE visitor = ?", who, visitor);
    } else {
      this.sql.exec("INSERT OR REPLACE INTO state VALUES (?, ?, ?, ?)", key, v, who, at);
    }
    this.sql.exec("INSERT INTO history (key, value, author, at, visitor) VALUES (?, ?, ?, ?, ?)", key, v, who, at, visitor);
    const row = { key, value: JSON.parse(v), author: who, at };
    this.#broadcast({ type: "set", row }, visitor);
    return { row };
  }

  // Clears answers, bookings and history (after testing, before sharing). Settings, limits and files stay.
  clearState() {
    this.sql.exec("DELETE FROM state; DELETE FROM pstate; DELETE FROM history; DELETE FROM visits; DELETE FROM aliases; DELETE FROM bookings; DELETE FROM booking_ips;");
    this.#broadcast({ type: "reset" });
    return { ok: true };
  }

  exportAll() {
    const parse = (r) => ({ ...r, value: JSON.parse(r.value) });
    const history = this.sql.exec("SELECT id, key, value, author, at, visitor FROM history ORDER BY id").toArray().map(parse);
    const private_state = this.sql.exec("SELECT visitor, key, value, author, at FROM pstate ORDER BY visitor, key").toArray().map(parse);
    const visits = this.sql.exec("SELECT visitor, first_at, last_at, visits, name, device FROM visits ORDER BY first_at").toArray();
    const merged = this.sql.exec("SELECT visitor, target, at FROM aliases ORDER BY at").toArray();
    const bookings = this.sql.exec("SELECT id, limit_name AS \"limit\", name, email, note, at, visitor FROM bookings ORDER BY limit_name, id").toArray();
    return { info: this.info(), state: this.getState(), private_state, visits, bookings, history, merged };
  }

  // Private apps: one person who used two browsers (phone and laptop) shows up as two visitors.
  // Folds `from` into `into`: answers (the newer one wins where both answered), history and visits.
  // `from`'s browser keeps its cookie, so its id becomes an alias and that browser sees the merged answers.
  mergeVisitors(from, into) {
    if (!VISITOR_RE.test(from) || !VISITOR_RE.test(into)) return { error: "bad visitor" };
    into = this.#canon(into);
    if (from === into || this.#canon(from) === into) return { error: "those are already the same visitor" };
    const known = (v) => this.sql.exec("SELECT 1 FROM visits WHERE visitor = ? UNION SELECT 1 FROM pstate WHERE visitor = ?", v, v).toArray().length > 0;
    if (!known(from) || !known(into)) return { error: "no such visitor" };
    this.sql.exec(
      `INSERT INTO pstate (visitor, key, value, author, at) SELECT ?, key, value, author, at FROM pstate WHERE visitor = ? AND true
       ON CONFLICT (visitor, key) DO UPDATE SET value = excluded.value, author = excluded.author, at = excluded.at WHERE excluded.at > pstate.at`,
      into, from);
    this.sql.exec("DELETE FROM pstate WHERE visitor = ?", from);
    this.sql.exec("UPDATE history SET visitor = ? WHERE visitor = ?", into, from);
    // Bookings move too; where both browsers booked the same thing, the one being kept wins and a place is freed.
    this.sql.exec("UPDATE OR IGNORE bookings SET visitor = ? WHERE visitor = ?", into, from);
    this.sql.exec("DELETE FROM bookings WHERE visitor = ?", from);
    const a = this.sql.exec("SELECT * FROM visits WHERE visitor = ?", from).toArray()[0];
    const b = this.sql.exec("SELECT * FROM visits WHERE visitor = ?", into).toArray()[0];
    if (a && b) {
      this.sql.exec("UPDATE visits SET first_at = ?, last_at = ?, visits = ?, name = coalesce(name, ?), device = coalesce(device, ?) WHERE visitor = ?",
        a.first_at < b.first_at ? a.first_at : b.first_at, a.last_at > b.last_at ? a.last_at : b.last_at, a.visits + b.visits, a.name, a.device, into);
    } else if (a) {
      this.sql.exec("INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?)", into, a.first_at, a.last_at, a.visits, a.name, a.device);
    }
    this.sql.exec("DELETE FROM visits WHERE visitor = ?", from);
    this.sql.exec("UPDATE aliases SET target = ? WHERE target = ?", into, from);
    this.sql.exec("INSERT OR REPLACE INTO aliases VALUES (?, ?, ?)", from, into, new Date().toISOString());
    // Open tabs: both reload their answers; `from`'s sockets close so they reconnect under the merged id.
    this.#broadcast({ type: "reset" }, into);
    this.#broadcast({ type: "reset" }, from);
    for (const ws of this.ctx.getWebSockets(from)) {
      try {
        ws.close(1012, "visitor merged");
      } catch {}
    }
    return { ok: true, into, answers: this.sql.exec("SELECT count(*) AS n FROM pstate WHERE visitor = ?", into).one().n };
  }

  // Private apps: a visitor's browser loaded their answers (so a person with the page open, not a
  // link preview). Loads within VISIT_GAP_MS of the last one belong to the same visit.
  recordVisit(visitor, name, device) {
    if (!VISITOR_RE.test(visitor)) return;
    visitor = this.#canon(visitor);
    const now = new Date();
    const row = this.sql.exec("SELECT last_at FROM visits WHERE visitor = ?", visitor).toArray()[0];
    const nm = name ? String(name).slice(0, LIMITS.maxAuthor) : null;
    const dev = device ? String(device).slice(0, 60) : null;
    if (!row) {
      if (this.sql.exec("SELECT count(*) AS n FROM visits").one().n >= LIMITS.maxPrivateRows) return;
      this.sql.exec("INSERT INTO visits VALUES (?, ?, ?, 1, ?, ?)", visitor, now.toISOString(), now.toISOString(), nm, dev);
    } else {
      const bump = now - Date.parse(row.last_at) > VISIT_GAP_MS ? 1 : 0;
      this.sql.exec("UPDATE visits SET last_at = ?, visits = visits + ?, name = coalesce(?, name), device = coalesce(?, device) WHERE visitor = ?",
        now.toISOString(), bump, nm, dev, visitor);
    }
  }

  // --- places and bookings -------------------------------------------------------------------------

  // {name: {places, taken, left}} for every limit. Counts only: safe to show any visitor.
  limitsInfo() {
    const out = {};
    for (const r of this.sql.exec("SELECT l.name, l.places, (SELECT count(*) FROM bookings b WHERE b.limit_name = l.name) AS taken FROM limits l ORDER BY l.name")) {
      out[r.name] = { places: r.places, taken: r.taken, left: Math.max(0, r.places - r.taken) };
    }
    return out;
  }

  #bookingChanged(visitor, key, value, who) {
    this.sql.exec("INSERT INTO history (key, value, author, at, visitor) VALUES (?, ?, ?, ?, ?)", key, JSON.stringify(value), who, new Date().toISOString(), visitor);
    this.#broadcast({ type: "places", limits: this.limitsInfo() });
    this.#broadcast({ type: "bookings" }, visitor);
  }

  myBookings(visitor) {
    visitor = this.#canon(visitor);
    return this.sql.exec("SELECT limit_name AS \"limit\", name, email, note, at FROM bookings WHERE visitor = ? ORDER BY limit_name", visitor).toArray();
  }

  // Take a place. Everything from the count to the insert happens without a pause, and this object
  // handles one request at a time, so two people can never both take the last place.
  // Booking again changes the details of the booking you already have.
  book(visitor, ip, limit, details) {
    if (this.#isClosed(this.#meta())) return { error: "closed", status: 423 };
    if (!VISITOR_RE.test(visitor || "")) return { error: "bad visitor", status: 400 };
    visitor = this.#canon(visitor);
    // The hidden field: people never see it, so only a program filling in every box sends it.
    if (details.trap) return { error: "not accepted", status: 400 };
    const name = String(details.name ?? "").trim();
    const email = String(details.email ?? "").trim();
    const note = String(details.note ?? "").trim();
    if (!name || name.length > LIMITS.maxAuthor) return { error: "a name is needed", status: 400 };
    if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: "that email address doesn't look right", status: 400 };
    if (note.length > LIMITS.maxNote) return { error: "that note is too long", status: 400 };
    const row = this.sql.exec("SELECT places FROM limits WHERE name = ?", limit).toArray()[0];
    if (!row) return { error: "nothing here to book", status: 404 };
    const at = new Date().toISOString();
    const mine = this.sql.exec("SELECT id FROM bookings WHERE limit_name = ? AND visitor = ?", limit, visitor).toArray()[0];
    if (mine) {
      this.sql.exec("UPDATE bookings SET name = ?, email = ?, note = ? WHERE id = ?", name, email || null, note || null, mine.id);
      this.#bookingChanged(visitor, `booking:${limit}`, { event: "changed", id: mine.id, name, email, note }, name);
      return { booking: this.myBookings(visitor).find((b) => b.limit === limit), limits: this.limitsInfo() };
    }
    const now = Date.now();
    this.sql.exec("DELETE FROM booking_ips WHERE at < ?", now - 864e5);
    if (this.sql.exec("SELECT count(*) AS n FROM booking_ips WHERE ip = ?", ip).one().n >= LIMITS.bookingsPerIpPerDay) return { error: "too many bookings today", status: 429 };
    if (this.sql.exec("SELECT count(*) AS n FROM bookings WHERE limit_name = ?", limit).one().n >= row.places) return { error: "full", status: 409 };
    const id = this.sql.exec("INSERT INTO bookings (limit_name, visitor, name, email, note, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", limit, visitor, name, email || null, note || null, at).one().id;
    this.sql.exec("INSERT INTO booking_ips VALUES (?, ?)", ip, now);
    this.#bookingChanged(visitor, `booking:${limit}`, { event: "booked", id, name, email, note }, name);
    return { booking: { limit, name, email: email || null, note: note || null, at }, limits: this.limitsInfo() };
  }

  cancelBooking(visitor, limit) {
    if (this.#isClosed(this.#meta())) return { error: "closed", status: 423 };
    visitor = this.#canon(visitor);
    const row = this.sql.exec("DELETE FROM bookings WHERE limit_name = ? AND visitor = ? RETURNING id, name", limit, visitor || "").toArray()[0];
    if (!row) return { error: "no booking to cancel", status: 404 };
    this.#bookingChanged(visitor, `booking:${limit}`, { event: "cancelled", id: row.id, name: row.name }, row.name);
    return { ok: true, limits: this.limitsInfo() };
  }

  // The owner removes someone's booking (by its number). Works when the app is closed.
  unbook(id, by = "Owner") {
    const row = this.sql.exec("DELETE FROM bookings WHERE id = ? RETURNING limit_name, visitor, name, email", id).toArray()[0];
    if (!row) return { error: "no booking with that number" };
    this.#bookingChanged(row.visitor, `booking:${row.limit_name}`, { event: "removed", id, name: row.name }, by);
    return { ok: true, removed: { id, limit: row.limit_name, name: row.name, email: row.email }, limits: this.limitsInfo() };
  }

  // The private link shown after booking: it carries the visitor's id to another device.
  async mineLink(slug, origin, visitor) {
    const t = await makeToken(this.env.SESSION_SECRET, { k: "mine", s: slug, v: this.#canon(visitor), e: Date.now() + VISITOR_DAYS * 864e5 });
    return `${origin}/${slug}/_mine?t=${t}`;
  }

  // Holding back a visitor (or one address) that writes too fast. Kept in memory only: it is
  // allowed to forget when the app goes quiet.
  #writes = new Map();
  tooFast(visitor, ip) {
    const now = Date.now();
    if (this.#writes.size > 5000) this.#writes.clear();
    let slow = false;
    for (const [key, max] of [[`v:${visitor}`, RATE.perVisitor], [`i:${ip}`, RATE.perIp]]) {
      if (key === "v:null") continue;
      const w = this.#writes.get(key);
      if (!w || now - w.start > RATE.windowMs) this.#writes.set(key, { start: now, n: 1 });
      else if (++w.n > max) slow = true;
    }
    return slow;
  }

  // --- signing in -------------------------------------------------------------------------------

  // Login throttling: per IP, plus a ceiling per app against guessing spread over many IPs.
  #loginBlocked(ip) {
    const now = Date.now();
    this.sql.exec("DELETE FROM login_failures WHERE at < ?", now - LOCKOUT.appWindowMs);
    const ipCount = this.sql.exec("SELECT count(*) AS n FROM login_failures WHERE ip = ? AND at > ?", ip, now - LOCKOUT.ipWindowMs).one().n;
    const appCount = this.sql.exec("SELECT count(*) AS n FROM login_failures").one().n;
    return ipCount >= LOCKOUT.perIp || appCount >= LOCKOUT.perApp;
  }

  // "ok", "wrong" or "blocked". A wrong guess is recorded before the answer goes back.
  async checkLogin(ip, password) {
    if (this.#loginBlocked(ip)) return "blocked";
    if (await checkPassword(password, this.#meta().pw_hash)) return "ok";
    this.sql.exec("INSERT INTO login_failures VALUES (?, ?)", ip, Date.now());
    return "wrong";
  }

  // Has this one-time link been used? Asked when the link is opened, which doesn't use it.
  nonceUsed(nonce) {
    return this.sql.exec("SELECT 1 FROM used_nonces WHERE nonce = ?", nonce).toArray().length > 0;
  }

  // One-time links: true the first time a nonce is seen, false after.
  useNonce(nonce, exp) {
    this.sql.exec("DELETE FROM used_nonces WHERE exp < ?", Date.now());
    if (this.sql.exec("SELECT 1 FROM used_nonces WHERE nonce = ?", nonce).toArray().length) return false;
    this.sql.exec("INSERT INTO used_nonces VALUES (?, ?)", nonce, exp);
    return true;
  }

  // One-time sign-in link: {name?, minutes?, visitor?}. Dies on first use, after `minutes`, or on a password change.
  async mintLink(slug, origin, body) {
    const g = this.gate();
    const minutes = Math.min(Math.max(Number(body.minutes) || 30, 1), 7 * 24 * 60);
    const payload = { k: "enter", s: slug, f: fingerprint(g.pw_hash), n: crypto.randomUUID(), e: Date.now() + minutes * 60e3 };
    if (body.name) payload.a = String(body.name).slice(0, LIMITS.maxAuthor);
    if (body.visitor) {
      if (!VISITOR_RE.test(body.visitor)) return { error: "bad visitor id" };
      payload.v = body.visitor;
    }
    const t = await makeToken(this.env.SESSION_SECRET, payload);
    return { url: `${origin}/${slug}/_enter?t=${t}`, expires_at: new Date(payload.e).toISOString() };
  }

  // --- the owner's page --------------------------------------------------------------------------

  // Owner sign-ins carry this number. Raising it signs every device out and kills unused owner links.
  ownerGen() {
    return Number(this.#meta().owner_gen || 0);
  }

  ownerSignOutEverywhere() {
    this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('owner_gen', ?)", String(this.ownerGen() + 1));
    return { ok: true };
  }

  // One-time link to <app>/_owner. Used by pressing Continue, like a sign-in link.
  async mintOwnerLink(slug, origin, body) {
    const minutes = Math.min(Math.max(Number(body.minutes) || 30, 1), 24 * 60);
    const payload = { k: "owner-enter", s: slug, g: this.ownerGen(), n: crypto.randomUUID(), e: Date.now() + minutes * 60e3 };
    const t = await makeToken(this.env.SESSION_SECRET, payload);
    return { url: `${origin}/${slug}/_owner/enter?t=${t}`, expires_at: new Date(payload.e).toISOString() };
  }

  // --- files ------------------------------------------------------------------------------------

  listFiles() {
    return this.sql.exec("SELECT path, type, size, etag, at FROM files ORDER BY path").toArray();
  }

  fileMeta(path) {
    return this.sql.exec("SELECT path, type, size, etag, pieces FROM files WHERE path = ?", path).toArray()[0] || null;
  }

  filePiece(path, seq) {
    const row = this.sql.exec("SELECT data FROM file_pieces WHERE path = ? AND seq = ?", path, seq).toArray()[0];
    return row ? row.data : null;
  }

  // A file arrives as one or more pieces of at most 1 MB ({part, parts}, counted from 0). Pieces wait
  // in upload_pieces until the last one lands; only then does the file change, all at once.
  async putFilePiece({ path, type, etag, upload, part = 0, parts = 1 }, bytes) {
    if (bytes.byteLength > LIMITS.pieceBytes) return { error: "piece too large: send files in pieces of at most 1 MB", status: 413 };
    if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || part < 0 || part >= parts) return { error: "bad piece numbers" };
    if (parts * LIMITS.pieceBytes > LIMITS.maxFileBytes + LIMITS.pieceBytes) return { error: "file too large (25 MB at most)", status: 413 };
    if (parts > 1 && !/^[A-Za-z0-9-]{8,64}$/.test(upload || "")) return { error: "bad upload id" };
    const isNew = !this.fileMeta(path);
    if (isNew && this.sql.exec("SELECT count(*) AS n FROM files").one().n >= LIMITS.maxFiles) return { error: "too many files in this app" };
    const id = parts > 1 ? upload : crypto.randomUUID();
    this.sql.exec("DELETE FROM upload_pieces WHERE at < ?", Date.now() - STALE_UPLOAD_MS);
    this.sql.exec("INSERT OR REPLACE INTO upload_pieces VALUES (?, ?, ?, ?)", id, part, bytes, Date.now());
    if (part < parts - 1) return { ok: true, path, received: part + 1, of: parts };

    const got = this.sql.exec("SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS size FROM upload_pieces WHERE upload = ?", id).one();
    if (got.n !== parts) {
      this.sql.exec("DELETE FROM upload_pieces WHERE upload = ?", id);
      return { error: "some pieces of the file are missing: send it again" };
    }
    const others = this.sql.exec("SELECT coalesce(sum(size), 0) AS n FROM files WHERE path != ?", path).one().n;
    if (others + got.size > LIMITS.maxAppBytes) {
      this.sql.exec("DELETE FROM upload_pieces WHERE upload = ?", id);
      return { error: "this app's files would pass 250 MB", status: 413 };
    }
    // The command-line tool sends the file's MD5; work it out here only for a small one-piece file.
    const tag = /^[0-9a-f]{32}$/.test(etag || "") ? etag : parts === 1 ? hex(await crypto.subtle.digest("MD5", bytes)) : crypto.randomUUID().replace(/-/g, "");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM file_pieces WHERE path = ?", path);
      this.sql.exec("INSERT INTO file_pieces (path, seq, data) SELECT ?, seq, data FROM upload_pieces WHERE upload = ?", path, id);
      this.sql.exec("DELETE FROM upload_pieces WHERE upload = ?", id);
      this.sql.exec("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?, ?)", path, type || "application/octet-stream", got.size, tag, parts, new Date().toISOString());
    });
    return { ok: true, path, size: got.size, etag: tag };
  }

  deleteFile(path) {
    this.sql.exec("DELETE FROM file_pieces WHERE path = ?", path);
    this.sql.exec("DELETE FROM files WHERE path = ?", path);
    return { ok: true };
  }

  async destroy() {
    const files = this.live ? this.sql.exec("SELECT count(*) AS n FROM files").one().n : 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1001, "app deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.live = false;
    return { ok: true, files_deleted: files };
  }

  // --- visitors ---------------------------------------------------------------------------------

  // Every visitor request for this app arrives here from the Worker, unchanged.
  async fetch(req) {
    return visit(this, this.env, req);
  }

  // Live updates. Each socket is tagged with its visitor, so private answers and news of a
  // visitor's own bookings reach only their own tabs. Hibernatable sockets: an idle app with open
  // tabs costs nothing.
  acceptSocket(visitor) {
    visitor = this.#canon(visitor);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, visitor && VISITOR_RE.test(visitor) ? [visitor] : []);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (msg === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code, "closing");
    } catch {}
  }
}

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS apps (slug TEXT PRIMARY KEY, created_at TEXT);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  add(slug) {
    this.sql.exec("INSERT OR IGNORE INTO apps VALUES (?, ?)", slug, new Date().toISOString());
  }

  remove(slug) {
    this.sql.exec("DELETE FROM apps WHERE slug = ?", slug);
    this.sql.exec("DELETE FROM settings WHERE k = 'home' AND v = ?", slug);
  }

  list() {
    return this.sql.exec("SELECT slug FROM apps ORDER BY created_at DESC").toArray().map((r) => r.slug);
  }
}
