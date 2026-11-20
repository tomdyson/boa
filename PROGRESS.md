# Progress

A short log so a new conversation can pick up. Written 20 November 2026.

## Done

- **Step 6, Tom's instance (20 Nov, evening).** `boa setup --domain boa.tomd.org` deployed the Worker `boa` to his
  Cloudflare account; `boa check` against https://boa.tomd.org passed all 179 checks; `boa doctor` is clean. It also
  answers at boa.tom-9c4.workers.dev. No apps on it yet, and no home app. Settings are in `~/.config/boa/`; his app
  folders default to `~/Documents/code/<app>/`.
- **Step 7, the guide, published (20 Nov).** `boa new guide --open --private`, `boa push guide guide`, `boa home guide`:
  it is at https://boa.tomd.org/guide/ and the bare address leads to it. Checked live at desktop width and 375 px;
  it loads nothing from other websites. To change it: edit `guide/index.html`, then `boa push guide guide`.
- **Step 8, first half (20 Nov).** Public repo github.com/tomdyson/boa created, `main` pushed, tagged `v1`.

- **Step 1, port from dwa.** Worker (`worker/`), `cli/boa` in Node with no packages, `scripts/smoke.js`. Same behaviour
  as dwa: password or open access, shared or private answers, visits, merge, live updates, one-time links with a
  Continue page, lockout, close and reopen, export, reset, delete.
- **Step 2, sign-ups.** Limits (named things with a fixed number of places) enforced in the app's Durable Object;
  `book`, `cancel`, `left` in the browser library; a private change-or-cancel link after booking; 20 bookings a day
  per address per app; a hidden field for bots; 60 writes per ten seconds per visitor. `boa settings`, `boa unbook`,
  `boa data --csv`. Every visitor now gets a visitor cookie (it says whose bookings are whose).
- **Step 3, owner page.** `<app>/_owner`, reached by a one-time link from `boa owner <app>`; tables that turn into
  cards on a phone; CSV downloads; remove a booking; signed in for a year; `boa owner --signout` signs every device out.
- **Step 4, setup and upkeep.** `boa setup` (`--subdomain`, `--domain`, `--account`, `--apps-dir`, `--from backup.zip`,
  `--local`), `doctor`, `check`, `update`, `backup`, `home`, `deploy`. `scripts/test-setup.js` runs them from a clean
  clone with a temporary home folder against a practice Worker.
- **Step 5, skill, templates, README.** `skill/SKILL.md`; `templates/checklist`, `questionnaire`, `signup` (checked in
  the browser at desktop width and 375 px); `README.md`.
- **Step 7, the guide, written.** `guide/index.html`, ported from dwa's `apps/build-your-own-apps/` (including its
  uncommitted wording). Naming step removed; old steps 5 and 6 replaced by one "Install boa" step; times now add up to
  65 minutes for steps 1 to 6; step ids are new (`accounts`, `claude-app`, `claude-code`, `cloudflare`, `install`,
  `first-app`, `looking-after`, `own-domain`). Checked locally at desktop width and 375 px.

Tests: `node scripts/smoke.js --local` (179 checks) and `node scripts/test-setup.js` (28 checks), both against `boa dev`.

- **Independent review (20 Nov).** A second, unbriefed read of the Worker and the command found no way in without the
  key and no script injection, and these, all fixed and tested: history had no ceiling (now the newest 50,000 changes
  or 16 MB, and 8 MB of answers per app); `reset` and `rm` couldn't run if the copy-first failed (`--no-copy`); forms
  posted from other websites could hand a visitor someone else's identity (refused now, by `Origin`); live connections
  outlived a password change; owner sign-ins and visitor links outlived deleting and recreating an app (each app now
  has a random id, renewed on reset); `setup --local` could overwrite a real setup's keys (it refuses now); counts per
  address treat an IPv6 /64 as one; smaller fixes to file size checks, the lockout wording and what `boa data` prints.

## Known limits, by design

- All apps share one web origin, so a script injected into one page could reach the others as that viewer. The defence
  is the rule "never x-html visitors' text, load nothing from elsewhere". Separate origins per app would need a
  wildcard domain, which workers.dev doesn't give.
- A booking's private link is the visitor's identity for that app until it is reset or deleted. Anyone it is forwarded
  to can change the booking.
- 200 wrong passwords in an hour lock an app's sign-in for everyone (links from `boa link` still work).
- `boa update` trusts whatever the highest `v*` tag on GitHub points at. Tags aren't signed.

## Waiting on Tom

1. **A card-free Cloudflare account to rehearse the guide on**, literally as a friend would (step 8, second half).
   Not to be created by Claude.
2. **His call, raised but not acted on:** what to do with the old guide at with.tomd.org/build-your-own-apps/ (one friend is
   partway through it and has hand-built his own version), and whether the guide should be removed from the dwa repo.

## Seen on the day

- Right after the deploy, this Mac's own DNS said boa.tomd.org didn't exist (the router remembers a "no such name"
  answer for up to 30 minutes), while public DNS had it. The `boa` command got round it by asking Cloudflare's DNS;
  a browser on the same network has to wait. A friend's first deploy may show the same thing.

## To verify in the rehearsal on a card-free account (can't be tested from here)

- **Processor time on the free plan.** A request gets about 10 ms. Password hashing was cut to 20,000 PBKDF2 rounds
  (about 3 ms on this Mac) for that reason; watch for Cloudflare error 1102 on sign-in and on `boa push` of big files.
- **A brand-new account with no workers.dev name.** `boa setup` reads `/accounts/<id>/workers/subdomain` with Wrangler's
  token and sets the name only when Cloudflare clearly says there isn't one (HTTP 404, error code 10007, or an empty
  result). What Cloudflare really answers in that case isn't documented. If it's something else, setup falls through
  to the deploy and reports Wrangler's own message.
- **How long a new workers.dev address takes to start answering** (setup waits up to five minutes).
- The Durable Objects free plan itself: SQLite-backed classes deploy without a card.

## Differences from dwa worth knowing

- Files are stored in the app's Durable Object in pieces of at most 1 MB (no R2). The command sends big files piece by piece.
- Each app's Durable Object answers visitors itself (`worker/src/visit.js`), so a page request costs one Durable Object
  request, not two. The Worker only does the admin API, the shared files under `/_boa/` and the hand-off.
- An address with no app stores nothing (the object makes its tables only when an app is created).
- Password hashing is 20,000 rounds of PBKDF2, not 100,000 (see above). The round count is stored in each hash.
- Apps have no closing date unless one is given (`boa new --days N`).
- Alpine.js and the fonts are served by the Worker at `/_boa/…`; pages load nothing from other websites.
- A page opens with one request (`_api/start`) for its settings, answers and bookings.
- App passwords are remembered in `~/.config/boa/passwords.json` by app name, so they survive a change of address.
- The local practice Worker is on port 8798 (`boa dev`), so it doesn't clash with dwa's 8799.

## Ideas not done

- A Content-Security-Policy header that enforces "loads nothing from other websites" (today `boa push` only warns).
- More than one place per booking ("me and a friend").
- `boa uninstall` (the README lists the steps instead).
