// Tests for t3-common, outside the app: node t3-common/test.mjs [machine]
// The "herdr" module is a stand-in. What each OS would run is compared as commands; the sh scripts (folder lists,
// stat, the NFD retry) really run, through this computer's sh and, given a machine, through `hc exec --on` there.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname, machine = process.argv[2] ?? null;
const box = mkdtempSync(join(tmpdir(), "t3c-")), slash = (p) => p.replace(/\\/g, "/");

// The stand-in: window().platform from T.os; exec either records or really runs.
writeFileSync(join(box, "package.json"), '{"type":"module"}');
writeFileSync(join(box, "herdr.mjs"), `
const T = globalThis.T;
export const window = () => ({ platform: T.os });
export const home = () => T.home;
export const appHome = () => T.appHome;
export const notify = (n) => { T.notes.push(n); return "n"; };
export async function exec(cmd, args = [], opts = {}) { T.calls.push({ cmd, args, on: opts?.on ?? null }); return T.run(cmd, args, opts?.on ?? null); }
`);
for (const f of ["platform.js", "fsx.js", "paths.js"]) writeFileSync(join(box, f), readFileSync(join(here, f), "utf8").replace(/from "herdr"/g, 'from "./herdr.mjs"'));
writeFileSync(join(box, "where.js"), 'export const MOD = "t3-files";');

const real = (cmd, args, on) => {
  const r = on ? spawnSync("hc", ["exec", "--json", "--on", on, "--", cmd, ...args], { encoding: "utf8" }) : spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) throw r.error;
  if (!on) return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  const j = JSON.parse(r.stdout);
  return { code: j.code, stdout: Buffer.from(j.stdout, "base64").toString("utf8"), stderr: Buffer.from(j.stderr, "base64").toString("utf8") };
};
globalThis.T = { os: "linux", home: "/home/me", appHome: "/home/me/.config/herdr-app", calls: [], notes: [], run: () => ({ code: 0, stdout: "", stderr: "" }) };
const T = globalThis.T;
const P = await import(pathToFileURL(join(box, "platform.js")));
const X = await import(pathToFileURL(join(box, "paths.js")));
const F = await import(pathToFileURL(join(box, "fsx.js")));

let bad = 0, n = 0;
const eq = (name, got, want) => {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  bad++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
};
const calls = async (os, f, reply) => {
  T.os = os; T.calls = []; T.notes = []; T.run = reply ?? (() => ({ code: 0, stdout: "", stderr: "" }));
  await f();
  return T.calls.map((c) => [c.cmd, ...c.args]);
};

// ── platform.js: what each OS runs ──
eq("open url windows", await calls("windows", () => P.openExternal("https://a.b/?x=1&y=2")), [["cmd", "/c", "start", "", "https://a.b/?x=1^&y=2"]]);
eq("open file windows", await calls("windows", () => P.openExternal("C:/a b/c.txt")), [["cmd", "/c", "start", "", "C:\\a b\\c.txt"]]);
eq("open macos", await calls("macos", () => P.openExternal("/Users/me/a.txt")), [["open", "/Users/me/a.txt"]]);
eq("open linux", (await calls("linux", () => P.openExternal("/home/me/a.txt")))[0].slice(0, 2), ["sh", "-c"]);
eq("reveal file windows", await calls("windows", () => P.reveal("C:/x/y.txt", false)), [["explorer", "/select,C:\\x\\y.txt"]]);
eq("reveal dir windows", await calls("windows", () => P.reveal("C:/x", true)), [["explorer", "C:\\x"]]);
eq("reveal file macos", await calls("macos", () => P.reveal("/a/b.txt", false)), [["open", "-R", "/a/b.txt"]]);
eq("reveal dir macos", await calls("macos", () => P.reveal("/a", true)), [["open", "/a"]]);
{
  const c = await calls("linux", () => P.reveal("/home/me/한 #.txt", false));
  eq("reveal file linux: dbus uri, then parent", c[0].slice(-2), ["file:///home/me/%ED%95%9C%20%23.txt", "/home/me"]);
  eq("reveal file linux: dbus first", /FileManager1\.ShowItems/.test(c[0][2]), true);
}
eq("labels", ["windows", "macos", "linux"].flatMap((os) => { T.os = os; return [P.revealLabel(true), P.revealLabel(false)]; }),
  ["Open in File Explorer", "Reveal in File Explorer", "Open in Finder", "Reveal in Finder", "Open in file manager", "Show in file manager"]);
eq("copy macos", (await calls("macos", () => P.copyText("hi")))[0].slice(2), ['printf %s "$1" | pbcopy', "sh", "hi"]);
eq("copy windows", (await calls("windows", () => P.copyText("it's")))[0].slice(-1)[0].endsWith("Set-Clipboard -Value 'it''s'"), true);
await calls("linux", () => P.copyText("hi"), () => ({ code: 127, stdout: "", stderr: "" }));
eq("copy linux without a tool says so", T.notes.map((x) => x.body), ["Copying here needs wl-copy, xclip or xsel"]);
eq("python", [["windows", null], ["windows", "vps"], ["macos", null], ["linux", null]].map(([os, on]) => { T.os = os; return P.pythonCmd(on); }),
  ["python", "python3", "python3", "python3"]);
{
  let pid;
  const c = await calls("linux", async () => { pid = await P.startHidden("ssh", ["-f", "-N", "-L", "9:127.0.0.1:9", "h"], "-L 9:127.0.0.1:9"); },
    () => ({ code: 0, stdout: "4242\n", stderr: "" }));
  eq("startHidden posix: pid", pid, 4242);
  eq("startHidden posix: match first, then the command", c[0].slice(3), ["sh", "-L 9:127.0.0.1:9", "ssh", "-f", "-N", "-L", "9:127.0.0.1:9", "h"]);
  const w = await calls("windows", async () => { pid = await P.startHidden("ssh", ["-N", "it's"], "x"); }, () => ({ code: 0, stdout: "77\r\n", stderr: "" }));
  eq("startHidden windows: pid", pid, 77);
  eq("startHidden windows: Start-Process hidden", w[0].at(-1).includes("(Start-Process ssh -WindowStyle Hidden -PassThru -ArgumentList '-N','it''s').Id"), true);
  eq("kill", [await calls("windows", () => P.killPid(5)), await calls("macos", () => P.killPid(5))], [[["taskkill", "/PID", "5", "/F"]], [["kill", "5"]]]);
}

// ── paths.js ──
T.os = "windows"; T.home = "C:\\Users\\me";
eq("resolve windows", ["~/a", "/c/x/y", "C:\\x\\..\\y", "b.ts:12:3", "c:/"].map((s) => X.resolve(s, { cwd: "C:/w", on: null })),
  ["C:/Users/me/a", "C:/x/y", "C:/y", "C:/w/b.ts", "C:/"]);
eq("resolve windows, other machine", X.resolve("~/a/", { cwd: "/srv", on: "vps" }), "~/a");
T.os = "linux"; T.home = "/home/me";
eq("resolve linux", ["~", "/c/x", "../b", "./a//b"].map((s) => X.resolve(s, { cwd: "/w/v", on: null })), ["/home/me", "/c/x", "/w/b", "/w/v/a/b"]);
eq("parentOf", ["/a/b", "/a", "C:/a", "C:/", "x"].map(X.parentOf), ["/a", "/", "C:/", "C:/", "x"]);
T.os = "windows";
eq("under, windows ignores case", [X.under("C:/W/", "c:/w/a/b"), X.under("C:/w", "C:/wx/a"), X.under("/w", "/W/a", "vps")], ["a/b", null, null]);

// ── fsx.js: the sh scripts, really run ──
const nfc = "한글.txt", nfd = nfc.normalize("NFD");
async function fsxOn(label, on, root, cleanup) {
  T.os = "linux"; T.run = real;
  const r = (cmd, args) => real(cmd, args, on);
  r("sh", ["-c", 'rm -rf "$1" && mkdir -p "$1/sub dir/.git" "$1/.hidden" && : > "$1/a.txt" && : > "$1/$2" && ln -s "sub dir" "$1/link"', "sh", root, nfd]);
  const items = (await F.list(root, on)).sort((a, b) => a.name.localeCompare(b.name));
  const has = (name) => items.find((e) => e.name === name);
  eq(`${label}: list sees files, folders, dot folders`, [has("a.txt")?.dir, has("sub dir")?.dir, has(".hidden")?.dir], [false, true, true]);
  eq(`${label}: a link to a folder is a folder`, has("link")?.dir, true);
  eq(`${label}: skipGit`, (await F.list(`${root}/sub dir`, on, { skipGit: true })).length, 0);
  eq(`${label}: limit`, (await F.list(root, on, { limit: 2 })).length, 2);
  eq(`${label}: listMany, a missing one is null`, [...(await F.listMany([root, `${root}/nope`], on)).values()].map((v) => v && v.length > 0), [true, null]);
  let threw = false; try { await F.list(`${root}/nope`, on); } catch { threw = true; }
  eq(`${label}: list of a missing folder throws`, threw, true);
  const st = await F.stat([root, `${root}/a.txt`, `${root}/nope`, `${root}/${nfc}`], on);
  eq(`${label}: stat`, st.map((s) => s.kind), ["d", "f", "-", "f"]);
  eq(`${label}: an NFC name finds the NFD file`, st[3].path.normalize("NFC") === `${root}/${nfc}`, true);
  eq(`${label}: fold matches both forms`, F.fold(nfd) === F.fold(nfc), true);
  cleanup?.();
}
{
  const local = slash(mkdtempSync(join(tmpdir(), "t3c-fs-")));
  // Git Bash's sh, as on this Windows computer; on macOS and Linux, the system's.
  await fsxOn("sh here", null, local + "/r", () => rmSync(local, { recursive: true, force: true }));
}
if (machine) {
  const root = `/tmp/t3c-test-${process.pid}`;
  await fsxOn(`sh on ${machine}`, machine, root, () => real("rm", ["-rf", root], machine));
  T.os = "windows";
  eq(`stat ~ on ${machine}`, (await F.stat(["~"], machine))[0].kind, "d");
}

rmSync(box, { recursive: true, force: true });
console.log(bad ? `${bad} of ${n} failed` : `all ${n} passed`);
process.exit(bad ? 1 : 0);
