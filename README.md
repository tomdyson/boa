# boa

Small web apps on your own Cloudflare account, made by describing them to Claude.

Say "make me a page where friends can pick dates for dinner" or "a sign-up page for my Tuesday classes, twelve places each". A few minutes later you have a web page with its own address. People tick, choose, write or book on it; their answers are saved as they go; and you can ask Claude what everyone said, or look on your phone.

boa is the machinery behind that: one small program that runs on Cloudflare and serves every app you make, a `boa` command for your Mac, and a skill that teaches Claude how to use it. It runs on Cloudflare's free plan, with no payment card.

If you are not a programmer, you don't need to read past the next section. The [guide](https://boa.tomd.org/guide/) walks you through it, and Claude does the typing.

## Installing

You need a Mac, [Node.js](https://nodejs.org) 22.12 or newer, git, a free Cloudflare account, and Wrangler (Cloudflare's own tool) signed in to it: `npx wrangler login`.

```bash
git clone https://github.com/tomdyson/boa.git ~/Apps/boa
```

```bash
~/Apps/boa/cli/boa setup
```

`boa setup` checks Node.js and the Cloudflare sign-in, makes two long random keys and stores them on your Mac, puts the Worker on your Cloudflare account, links the Claude skill and the `boa` command, and then tests everything end to end. It is safe to run again: it never replaces the keys.

- A new Cloudflare account hasn't yet chosen the name that ends its addresses (`boa.<name>.workers.dev`). Setup asks for one rather than letting Cloudflare make one up: `boa setup --subdomain <name>`.
- To use your own domain instead, once it is active on Cloudflare: `boa setup --domain apps.example.com`.

Then start a new Claude session and ask for an app.

## What goes where on your Mac

| Place | What |
|---|---|
| `~/Apps/boa/` | this folder: the tool, the skill and the starting pages. Don't edit it; `boa update` replaces it. |
| `~/Apps/<app>/` | the page files for each app you make |
| `~/Apps/boa-exports/` | copies of answers, saved whenever an app is reset or deleted |
| `~/.config/boa/` | settings and keys, readable only by you. Never share them. |
| `~/.claude/skills/boa` | a link to `skill/` here, which is how Claude knows about boa |
| `~/.local/bin/boa` | a link to `cli/boa` here, which is what makes `boa` a command |

## How it fits together

One Cloudflare Worker, called `boa`, serves every app at `https://boa.<name>.workers.dev/<app>/`. Making an app uploads files and settings to that Worker. It never changes the Worker itself.

| Piece | Holds |
|---|---|
| The Worker (`worker/src/index.js`) | the admin API the `boa` command uses, the files every page shares (`/_boa/`: Alpine.js and two fonts), and the hand-off of each visitor's request to the right app |
| One Durable Object per app (`AppStore`, SQLite) | everything about that app: its files, settings and password hash, current answers, bookings and limits, a history of changes (the most recent 50,000), wrong-password counts, used links, and the live connections to open pages |
| One `Registry` Durable Object | the list of apps, and which one the bare address leads to |

Each app's object answers its visitors itself (`worker/src/visit.js`), so a page request costs one Durable Object request. An address nobody has made an app at stores nothing.

**Files** are kept in the app's own object, cut into pieces of at most 1 MB, because the free plan has no file storage of its own without a card. A file is at most 25 MB and an app's files 250 MB in all.

**The browser library** (`worker/src/boa.client.js`, served at `<app>/_boa.js`) gives a page an Alpine.js store: read and save answers, see who answered and when, book and cancel places, and hear other people's changes within a second over a WebSocket. `skill/SKILL.md` has the full list.

### Who can see what

- **Password apps:** one shared password per app, stored only as a slow hash (PBKDF2, 20,000 rounds: the free plan's processor allowance per request doesn't stretch to more). Signing in sets a signed cookie that works for that app only and lasts 30 days. Changing the password signs everyone out and cuts off pages that were open.
- **Wrong passwords:** ten from one internet address in 15 minutes, or 200 on one app in an hour, lock sign-in for a while (for everyone, in the second case). Each wrong try also waits three quarters of a second.
- **Open apps** need no sign-in: anyone with the address can read and answer.
- **Shared answers** are seen by everyone who can open the app. **Private answers** are seen only by the browser that gave them and by the owner; a signed cookie holding a random visitor id says whose are whose.
- **Bookings** are always private: a visitor sees their own, and how many places are left. Places are counted inside the app's object, which does one thing at a time, so the last place can only be taken once. After booking, a visitor gets a private link that opens their booking on another device. In a private app it opens their answers too. It keeps working until the app is reset or deleted, so it is theirs to keep safe.
- **One-time links** (`boa link`, `boa owner`) do nothing when opened: they show a Continue button, and pressing it is what uses the link. Message apps fetch links to make previews and would otherwise use them up.
- **The owner page** (`<app>/_owner`) is reached only by a one-time link from `boa owner`. The device then stays signed in for a year. `boa owner --signout` signs every device out.
- **The admin API** (`/_admin/…`) needs a long random key that only `~/.config/boa/` holds.
- **Every page** tells search engines to keep out and refuses to be shown inside another website.
- **Forms posted from other websites** to the sign-in and link pages are refused, as are live connections opened from other websites, so no other site can sign a visitor in as someone else.
- **Limits against filling it up:** answer names up to 200 characters, answers up to 64 KB each and 8 MB per app, 5,000 answers per shared app (500 per visitor in a private one), 60 saves per visitor in ten seconds and 300 from one internet address, 20 bookings a day per internet address per app (`boa settings <app> --bookings-a-day N` changes it), and a hidden field that only programs fill in. History keeps the most recent 50,000 changes or 16 MB.
- **One address for everything.** All your apps share one web address. A page that ran a stranger's script could therefore reach your other apps, and your owner pages, as whoever was looking at it. That is why pages must never show visitors' words as HTML and must load nothing from other websites. `boa push` warns about the second; the first is a rule the skill gives Claude.
- **Not checked:** names and email addresses. They are whatever people type.
- **Nothing leaves:** the Worker sends no email and calls no other service, and pages load nothing from other websites.

## Updating

```bash
boa update
```

It fetches the newest released version into `~/Apps/boa`, puts it on Cloudflare, and runs the checks. Your apps and their answers are not touched. It refuses if files in the boa folder have been edited, because the update would overwrite them.

## What it costs

Nothing. boa uses only what Cloudflare's free plan includes, and a Cloudflare account with no card on it cannot be charged.

The free plan's daily allowances are shared by all your apps and start again at midnight UTC:

- 100,000 requests to the Worker
- 100,000 requests to Durable Objects (a page view is five or six)
- 100,000 rows written (an answer saved is two)
- 5 GB stored

That is thousands of page views a day. If a day's allowance runs out, visitors see "This page is having a rest" until midnight UTC, and nothing is lost.

## Backing up, and moving to a new Mac

Your apps and everyone's answers live on Cloudflare, so they survive a lost laptop. What a lost laptop takes with it is the key that lets you manage them.

```bash
boa backup ~/Documents
```

saves one zip with the settings and keys, each app's page files, and a copy of every app's answers. Keep it private: whoever has it can read and delete everything.

On a new Mac, install Node.js and git, sign Wrangler in, clone boa as above, then:

```bash
boa setup --from ~/Documents/boa-backup-20270114-093000.zip
```

## Removing everything

1. `boa backup` if you want to keep the answers.
2. Delete the Worker, which deletes every app, file and answer with it: `cd ~/Apps/boa/worker && npx wrangler delete` (or in the Cloudflare dashboard: Workers & Pages, then boa, then Settings, then Delete).
3. Delete from your Mac: `~/Apps/boa`, `~/.config/boa`, the links `~/.claude/skills/boa` and `~/.local/bin/boa`, and the two lines `boa setup` added to the end of `~/.zshrc`.
4. To withdraw Claude's access to Cloudflare: `npx wrangler logout`.

Your page files in `~/Apps/<app>/` are yours to keep or delete.

## If something goes wrong

`boa doctor` checks each part and says how to fix what it finds. `boa check` tests everything end to end using throwaway apps.

## Working on boa itself

```bash
boa dev                          # a practice copy on this Mac, at http://127.0.0.1:8798
boa --local new demo --title Demo --template checklist
boa --local push demo
node scripts/smoke.js --local    # every promise above, end to end
node scripts/test-setup.js       # setup, backup, restore and update, from a clean clone with a temporary home folder
```

- `cli/boa` is one Node.js file with no packages. Wrangler and the Tailwind CLI run through `npx` at versions pinned at the top of that file.
- `scripts/smoke.js` is what `boa check` runs. A change to the Worker goes: `node scripts/smoke.js --local`, then `boa deploy`, then `boa check`.
- `worker/wrangler.toml` has no account or domain in it; those live in each person's `~/.config/boa/`. Durable Object migrations there are append-only.
- The version is in `worker/src/version.js`. A release is a tag like `v1`; `main` always points at the newest one, so a fresh clone is the latest release and `boa update` moves to the highest tag.
- `templates/` holds the three starting pages, and `guide/` the guide itself, which is a boa app.

MIT licence. Alpine.js (MIT) and the Inter and Gowun Batang fonts (SIL Open Font License) are included under `worker/src/vendor/`.
