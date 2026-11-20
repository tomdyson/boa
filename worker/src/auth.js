// Password hashing and signed tokens (session cookies, one-time links), all on WebCrypto.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

// Cloudflare's free plan allows about 10 ms of processor time per request, and 100,000 rounds
// alone cost more than that. 20,000 rounds take 2 to 5 ms. The count is stored in each hash, so
// it can be raised later without breaking existing passwords. Guessing is held back by the
// lockout (see store.js), not by the round count.
const ITERATIONS = 20000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

// Stored as pbkdf2$<rounds>$<salt>$<hash>.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64u(salt)}$${b64u(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function checkPassword(password, stored) {
  const [scheme, rounds, salt, hash] = String(stored).split("$");
  const n = Number(rounds);
  if (scheme !== "pbkdf2" || !salt || !hash || !Number.isInteger(n) || n < 1000 || n > 100000) return false;
  const got = b64u(await pbkdf2(password, fromB64u(salt), n));
  return safeEqual(got, hash);
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// Token = base64url(JSON payload) + "." + HMAC. Every payload carries a kind (`k`) so a session
// cookie can never be replayed as an entry link or the other way round.
export async function makeToken(secret, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readToken(secret, token, kind) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(await hmac(secret, body), sig)) return null;
  try {
    const payload = JSON.parse(dec.decode(fromB64u(body)));
    if (payload.k !== kind || typeof payload.e !== "number" || payload.e < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// A short fingerprint of the password hash goes into each session, so changing an app's
// password signs everyone out of it.
export const fingerprint = (pwHash) => String(pwHash).slice(-12);
