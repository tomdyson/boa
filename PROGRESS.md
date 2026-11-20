# Progress

A short log so a new conversation can pick up. Newest state at the top of each list.

## Done

- **Step 1, port from dwa (20 Nov 2026).** Worker (`worker/`), `cli/boa` in Node with no packages, `scripts/smoke.js`.
  Same behaviour as dwa: password or open access, shared or private answers, visits, merge, live updates,
  one-time links with a Continue page, lockout, close and reopen, export, reset, delete. `node scripts/smoke.js --local` passes.

## Differences from dwa worth knowing

- Files are stored in the app's Durable Object in pieces of at most 1 MB (no R2). The command sends big files piece by piece.
- Each app's Durable Object answers visitors itself (`worker/src/visit.js`), so a page request costs one Durable Object
  request, not two. The Worker only does the admin API, the shared files under `/_boa/` and the hand-off.
- An address with no app stores nothing (the object makes its tables only when an app is created).
- Password hashing is 20,000 rounds of PBKDF2, not 100,000: the free plan allows about 10 ms of processor time per
  request and 100,000 rounds take about 12 ms. The round count is stored in each hash.
- Apps have no closing date unless one is given (`boa new --days N`).
- Alpine.js and the fonts are served by the Worker at `/_boa/…`.
- The local practice Worker is on port 8798 (`boa dev`), so it doesn't clash with dwa's 8799.

## Next

See the task list in the session that started this work: sign-ups, owner page, setup and upkeep commands, skill and
templates, Tom's instance, the guide, release.

## Undecided

Nothing yet.
