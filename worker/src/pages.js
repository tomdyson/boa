// The few pages the Worker writes itself. Everything else is the app's own files.

export const SEC_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const BASE_CSS = `
  body{margin:0;min-height:100vh;font-family:Inter,system-ui,sans-serif;color:#2B2B2B;
    background:#FAF5EE;background-image:repeating-linear-gradient(135deg,rgba(231,111,81,.045) 0 2px,transparent 2px 18px)}
  .card{background:#fff;border-radius:18px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.1);box-sizing:border-box}
  h1{font-family:'Gowun Batang',Georgia,serif;font-weight:400;font-size:1.5rem;margin:0 0 .4rem;line-height:1.25}
  .err{color:#b4412b}`;

function shell(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/_boa/fonts.css">
<style>${BASE_CSS}
  body{display:grid;place-items:center}
  .card{padding:2rem;width:min(22rem,calc(100vw - 2rem))}
  p{margin:0 0 1.2rem;font-size:.9rem;color:#6b6259}
  input,button{font:inherit;width:100%;box-sizing:border-box;padding:.65rem .85rem;border-radius:10px}
  input{border:1px solid #d9d1c7;margin-bottom:.8rem}input:focus{outline:2px solid #E76F51;border-color:transparent}
  button{border:0;background:#2B2B2B;color:#fff;cursor:pointer}button:hover{background:#000}
</style></head><body><main class="card">${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS } });
}

export function loginPage(slug, title, error) {
  return shell(
    title,
    `<h1>${esc(title)}</h1>
<p class="${error ? "err" : ""}">${error ? esc(error) : "Enter the password you were sent to open this page."}</p>
<form method="post" action="/${esc(slug)}/_login">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button>Open</button></form>`,
    error ? 401 : 200,
  );
}

export const lockedPage = (title) =>
  shell(title, `<h1>${esc(title)}</h1><p class="err">Too many wrong passwords. Please wait 15 minutes and try again.</p>`, 429);

// What opening a one-time link shows. The link is used only when the button is pressed, so a
// message app or mail scanner that fetches the address to build a preview can't use it up.
export const enterPage = (action, title, token, text = "This link opens the page for you, with no password. It works once.") =>
  shell(
    title,
    `<h1>${esc(title)}</h1>
<p>${esc(text)}</p>
<form method="post" action="${esc(action)}">
<input type="hidden" name="t" value="${esc(token)}">
<button autofocus>Continue</button></form>`,
  );

export const linkExpiredPage = () =>
  shell("Link expired", `<h1>This link has expired</h1><p>Links like this work once and for a short time. Ask for a new one, or use the password.</p>`, 410);

export const notFoundPage = () => shell("Not found", `<h1>Nothing here</h1><p>This page doesn't exist, or it has been removed.</p>`, 404);

// Shown when Cloudflare refuses a request, usually because the free plan's daily allowance is used up.
export const restingPage = () =>
  shell("Try again later", `<h1>This page is having a rest</h1><p>It has been very busy today. Please try again later, or tomorrow.</p>`, 503);
