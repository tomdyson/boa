#!/usr/bin/env node
"use strict";
// Tests `boa setup`, `doctor`, `home`, `backup`, restoring on a "new Mac" and `update`, as a friend's
// Mac would run them: from a clean git clone at ~/Apps/boa, with a temporary home folder, against a
// practice Worker started from that clone. Nothing is put on the internet, and the real home
// folder is not touched.
//
//   node scripts/test-setup.js          (about two minutes)

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const PORT = "8797";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "boa-test-setup-"));
const HOME = path.join(TMP, "home");
const HOME2 = path.join(TMP, "new-mac");
const ORIGIN = path.join(TMP, "origin");
const CLONE = path.join(HOME, "Apps", "boa");
const BOA = path.join(CLONE, "cli", "boa");

// npx would otherwise download Wrangler again into the temporary home.
const npmCache = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).stdout.trim();
// A made-up Cloudflare token: whatever happens, this test cannot reach a real account.
const env = (home) => ({ ...process.env, HOME: home, BOA_LOCAL_PORT: PORT, npm_config_cache: npmCache, CLOUDFLARE_API_TOKEN: "not-a-real-token", BOA_CONFIG_DIR: "", BOA_APPS_DIR: "", BOA_BASE_URL: "", BOA_ADMIN_TOKEN: "" });

const failures = [];
let passed = 0;
const everything = []; // all output, to prove no key is ever printed
function check(label, ok, detail = "") {
  if (ok) passed++;
  else failures.push(label);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${String(detail).trim().split("\n").slice(-12).join("\n        ")}`}`);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.mayFail) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function boa(args, home = HOME) {
  const r = spawnSync(process.execPath, [BOA, ...args], { encoding: "utf8", env: env(home), cwd: home });
  const out = `${r.stdout}\n${r.stderr}`;
  everything.push(out);
  return { status: r.status, out };
}
const git = (dir, args) => sh("git", ["-C", dir, "-c", "user.name=boa test", "-c", "user.email=test@example.com", ...args]);
const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);

async function main() {
  console.log(`Testing setup in ${TMP}`);
  // "origin": the files as they are in this folder now, committed and tagged v1.
  fs.mkdirSync(ORIGIN);
  for (const f of sh("git", ["-C", REPO, "ls-files", "-co", "--exclude-standard"]).stdout.split("\n").filter(Boolean)) {
    if (!fs.existsSync(path.join(REPO, f))) continue;
    fs.mkdirSync(path.dirname(path.join(ORIGIN, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(ORIGIN, f));
  }
  git(ORIGIN, ["init", "-q", "-b", "main"]);
  git(ORIGIN, ["add", "-A"]);
  git(ORIGIN, ["commit", "-q", "-m", "v1"]);
  git(ORIGIN, ["tag", "v1"]);
  fs.mkdirSync(path.join(HOME, "Apps"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "Documents"));
  fs.mkdirSync(HOME2);
  sh("git", ["clone", "-q", ORIGIN, CLONE]);

  console.log("before setup");
  let r = boa(["ls"]);
  check("a command before setup says to run setup", r.status === 1 && r.out.includes("boa setup"), r.out);
  r = boa(["setup"]);
  check("setup without a Cloudflare sign-in stops and says how to sign in", r.status === 1 && r.out.includes("login") && !fs.existsSync(path.join(HOME, ".config", "boa", "config.json")), r.out);
  r = boa(["setup", "--local"]);
  check("setup --local without the practice copy running says to start it", r.status === 1 && r.out.includes("boa dev"), r.out);

  // The practice Worker, started from the clone itself.
  const dev = spawn(process.execPath, [BOA, "dev"], { env: env(HOME), cwd: HOME, detached: true, stdio: "ignore" });
  const stop = () => {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  };
  process.on("exit", stop);
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    up = await fetch(`http://127.0.0.1:${PORT}/_admin`).then((x) => x.status === 401, () => false);
  }
  if (!up) throw new Error("the practice Worker didn't start");

  console.log("setup");
  r = boa(["setup", "--local"]);
  check("setup finishes and its checks pass", r.status === 0 && r.out.includes("boa is set up.") && /All \d+ checks passed/.test(r.out), r.out);
  const cfgFile = path.join(HOME, ".config", "boa", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  check("it stored a key and a session secret", /^[0-9a-f]{40,}$/.test(cfg.admin_token) && /^[0-9a-f]{64}$/.test(cfg.session_secret));
  check("the settings are readable only by their owner", mode(cfgFile) === "600" && mode(path.dirname(cfgFile)) === "700", `${mode(cfgFile)} ${mode(path.dirname(cfgFile))}`);
  const skill = path.join(HOME, ".claude", "skills", "boa");
  check("the Claude skill is linked", fs.lstatSync(skill).isSymbolicLink() && fs.existsSync(path.join(skill, "SKILL.md")));
  const cmd = path.join(HOME, ".local", "bin", "boa");
  check("the boa command is linked", fs.lstatSync(cmd).isSymbolicLink() && fs.realpathSync(cmd) === fs.realpathSync(BOA));
  check("new windows will find the command", fs.readFileSync(path.join(HOME, ".zshrc"), "utf8").includes('export PATH="$HOME/.local/bin:$PATH"'));
  r = boa(["setup", "--local"]);
  const again = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  check("running setup again changes no keys", r.status === 0 && r.out.includes("it already was") && again.session_secret === cfg.session_secret && again.admin_token === cfg.admin_token, r.out);
  check("and doesn't add the PATH line twice", fs.readFileSync(path.join(HOME, ".zshrc"), "utf8").split(".local/bin").length === 2);

  console.log("using it");
  r = boa(["new", "first-app", "--title", "First app", "--template", "checklist"]);
  const appDir = path.join(HOME, "Apps", "first-app");
  check("a new app's starting page lands beside the boa folder", r.status === 0 && fs.existsSync(path.join(appDir, "index.html")), r.out);
  r = boa(["push", "first-app"]);
  check("push builds the styles and publishes", r.status === 0 && r.out.includes("built app.css") && r.out.includes("2 uploaded"), r.out);
  boa(["set", "first-app", "travel.note", "hello from the test"]);
  r = boa(["data", "first-app"]);
  check("answers can be read back", r.out.includes("hello from the test"), r.out);
  r = boa(["home", "first-app"]);
  const root = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
  check("boa home makes the bare address lead to an app", r.status === 0 && root.status === 302 && root.headers.get("location").endsWith("/first-app/"), `${root.status} ${root.headers.get("location")}`);
  r = boa(["doctor", "--local"]);
  check("doctor finds nothing wrong", r.status === 0 && r.out.includes("Everything looks fine"), r.out);

  console.log("backup, and a new Mac");
  r = boa(["backup", path.join(HOME, "Documents")]);
  const zip = fs.readdirSync(path.join(HOME, "Documents")).find((f) => /^boa-backup-.*\.zip$/.test(f));
  const zipPath = path.join(HOME, "Documents", zip || "none");
  const listed = zip ? sh("unzip", ["-Z1", zipPath]).stdout : "";
  check("backup writes one private zip", r.status === 0 && Boolean(zip) && mode(zipPath) === "600", r.out);
  check("with the settings, the page files and the answers in it",
    ["boa-backup/settings/config.json", "boa-backup/apps/first-app/index.html", "boa-backup/answers/first-app.json", "boa-backup/README.txt"].every((f) => listed.includes(f)), listed);
  // (Both "Macs" share one boa folder here, so the new one is told where its apps go.)
  r = boa(["setup", "--from", zipPath, "--apps-dir", path.join(HOME2, "Apps")], HOME2);
  check("a new Mac takes over from the backup", r.status === 0 && r.out.includes("now looks after boa"), r.out);
  check("with the same key, and the page files back", JSON.parse(fs.readFileSync(path.join(HOME2, ".config", "boa", "config.json"), "utf8")).admin_token === again.admin_token
    && fs.existsSync(path.join(HOME2, "Apps", "first-app", "index.html")));
  r = boa(["ls"], HOME2);
  check("and it can see the apps", r.status === 0 && r.out.includes("first-app"), r.out);
  r = boa(["setup", "--from", zipPath], HOME2);
  check("restoring over existing settings needs --force", r.status === 1 && r.out.includes("--force"), r.out);

  console.log("update");
  r = boa(["update", "--local"]);
  check("update on the newest version says so", r.status === 0 && r.out.includes("already up to date (v1)"), r.out);
  fs.appendFileSync(path.join(ORIGIN, "README.md"), "\nA later release.\n");
  git(ORIGIN, ["commit", "-q", "-am", "v2"]);
  git(ORIGIN, ["tag", "v2"]);
  fs.appendFileSync(path.join(CLONE, "README.md"), "\nSomeone edited this.\n");
  r = boa(["update", "--local"]);
  check("update refuses when the boa folder has been edited", r.status === 1 && r.out.includes("have been edited") && r.out.includes("README.md"), r.out);
  git(CLONE, ["checkout", "-q", "."]);
  r = boa(["update", "--local"]);
  check("update fetches the new release and checks it", r.status === 0 && r.out.includes("Fetched boa v2") && r.out.includes("boa is now v2") && /All \d+ checks passed/.test(r.out), r.out);
  check("the boa folder is now at v2", sh("git", ["-C", CLONE, "describe", "--tags"]).stdout.trim() === "v2" && fs.readFileSync(path.join(CLONE, "README.md"), "utf8").includes("A later release."));

  console.log("afterwards");
  check("the boa folder is still an untouched clone", sh("git", ["-C", CLONE, "status", "--porcelain"]).stdout.trim() === "", sh("git", ["-C", CLONE, "status", "--porcelain"]).stdout);
  const devToken = fs.readFileSync(path.join(CLONE, "worker", ".dev.vars"), "utf8").match(/ADMIN_TOKEN=(\w+)/)[1];
  const all = everything.join("\n");
  check("no key was ever printed", ![cfg.admin_token, cfg.session_secret, again.admin_token, devToken].some((secret) => all.includes(secret)));
  stop();
}

main()
  .catch((e) => check(`the test stopped early: ${e.message}`, false))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures.length ? `\n${failures.length} of ${passed + failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : `\nAll ${passed} setup checks passed.`);
    process.exit(failures.length ? 1 : 0);
  });
