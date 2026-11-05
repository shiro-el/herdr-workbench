// Seeing a page as a browser does: a static server for the folder, on the machine the files are on (bound to
// 127.0.0.1 there), its port forwarded here over ssh when that's another machine, then the default browser.
// One server per (machine, folder), kept in shared "t3-files.servers" so every viewer reuses it.
import { exec, hc, home, shared, setShared, run } from "herdr";
import * as fs from "fs/promises";
import { openExternal, pythonCmd, startHidden, killPid, isWindows } from "./common/platform.js";

const KEY = "t3-files.servers";
const tryExec = (cmd, args, opts) => exec(cmd, args, opts).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
const sleep = (cx, ms) => cx.sleep(ms);

export const servers = () => shared(KEY) ?? {};
export const serverKey = (root, on) => `${on ?? ""}|${root}`;
const save = (k, v) => { const all = { ...servers() }; if (v) all[k] = v; else delete all[k]; setShared(KEY, all); };

export const openBrowser = (url) => void openExternal(url);

// Answers here (a server, or the tunnel to one).
async function answersHere(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.status > 0; } catch { return false; }
}
async function answersThere(port, on) {
  const r = await tryExec("curl", ["-s", "-o", "/dev/null", "-m", "2", "-w", "%{http_code}", `http://127.0.0.1:${port}/`], { on });
  return /^[1-5]\d\d$/.test(r.stdout.trim()) && r.stdout.trim() !== "000";
}

// python's http.server on a port the system picks, as a herdr-core terminal on that machine: a program `exec` starts
// is ended with its command, a core terminal lives on (no herdr.space label, so it shows on no screen).
// Returns { address, port }.
async function start(root, on, cx) {
  const python = pythonCmd(on);
  const r = await hc(["run", ...(on ? ["--on", on] : []), "--json", "--bg", "--no-parent", "--rm", "--cwd", root,
    "--label", "t3-files.serve=1", "--", python, "-u", "-m", "http.server", "0", "--bind", "127.0.0.1"]);
  let address = null;
  try { address = JSON.parse(r.stdout).address; } catch { /* below */ }
  const last = (text) => String(text).trim().split(/\r?\n/).pop();
  if (r.code !== 0 || !address) throw new Error(last(r.stderr || r.stdout || "hc run failed"));
  for (let i = 0; i < 40; i++) {
    await sleep(cx, 150);
    const out = (await hc(["read", address, "--lines", "8"]).catch(() => null))?.stdout ?? "";
    const port = Number(/port (\d+)/.exec(out)?.[1]);
    if (port) return { address, port };
    if (/Error|No module|not found|Traceback/.test(out)) { await hc(["kill", address]).catch(() => null); throw new Error(last(out)); }
  }
  await hc(["kill", address]).catch(() => null);
  throw new Error("http.server didn't say its port");
}

async function sshTarget(on) {
  const r = await hc(["machine", "ls", "--json"]).catch(() => null);
  try { return JSON.parse(r?.stdout ?? "{}").machines?.find((m) => m.name === on)?.target ?? on; } catch { return on; }
}

// The same port here. With ~/.ssh/herdr_tunnel ssh runs hidden; else in a tab, where it can ask for a password.
async function forward(port, on, cx) {
  const target = await sshTarget(on);
  const args = ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-L", `${port}:127.0.0.1:${port}`, target];
  const key = `${home()}/.ssh/herdr_tunnel`.replace(/\\/g, "/");
  if (await fs.exists(key).catch(() => false)) {
    const quiet = ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...args];
    // Hidden, and its pid kept so stop() ends it: ssh -f puts itself in the background on macOS and Linux.
    const pid = await startHidden("ssh", isWindows() ? quiet : ["-f", ...quiet], `-L ${port}:127.0.0.1:${port}`);
    for (let i = 0; i < 16; i++) { await sleep(cx, 250); if (await answersHere(port)) return { tunnel: pid }; }
  }
  run("terminal.open", { argv: ["ssh", ...args], name: `serve :${port} ⇄ ${on}`, place: "tab" });
  for (let i = 0; i < 120; i++) { await sleep(cx, 500); if (await answersHere(port)) return { tunnel: null }; }
  throw new Error("The tunnel didn't come up (ssh asks for the password in its tab)");
}

// A server for `root` on `on` that answers here; returns its port.
export async function ensure(root, on, cx) {
  const k = serverKey(root, on);
  let rec = servers()[k];
  if (rec && !(await (on ? answersThere(rec.port, on) : answersHere(rec.port)))) rec = null;
  if (!rec) { rec = await start(root, on, cx); save(k, rec); }
  if (on && !(await answersHere(rec.port))) { rec = { ...rec, ...(await forward(rec.port, on, cx)) }; save(k, rec); }
  return rec.port;
}

export async function stop(root, on) {
  const k = serverKey(root, on), rec = servers()[k];
  if (!rec) return;
  if (rec.address) await hc(["kill", rec.address]).catch(() => null);
  if (rec.tunnel) await killPid(rec.tunnel);
  save(k, null);
}

// The page's address: each part of the path encoded.
export const pageUrl = (port, path) => `http://localhost:${port}/${path.split("/").map(encodeURIComponent).join("/")}`;

// Forget a server that no longer answers (a reboot, a kill elsewhere), so no viewer offers to stop it.
export async function prune(root, on) {
  const k = serverKey(root, on), rec = servers()[k];
  if (rec && !(await (on ? answersThere(rec.port, on) : answersHere(rec.port)))) save(k, null);
}
