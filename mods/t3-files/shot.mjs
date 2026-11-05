// local change: a page as Chromium draws it, for the viewer's "Page" mode. Run with node (22+, for its WebSocket):
//   node shot.mjs <browser.exe or auto> <profile dir> <url> <out.png> <css width>
// A headless browser of its own (a fresh profile, so an open Chrome is untouched), the page at that width, the whole
// of it (to MAX_H) in one PNG at 2x. Prints "<css width> <css height>" of what it caught.
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const [browserArg, profile, url, out, widthArg] = process.argv.slice(2);

// "auto": Chrome, Edge or Chromium, wherever this system keeps them.
function findBrowser() {
  const env = process.env, list = process.platform === "win32"
    ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [
      `${d}/Google/Chrome/Application/chrome.exe`, `${d}/Microsoft/Edge/Application/msedge.exe`, `${d}/Chromium/Application/chrome.exe`, `${d}/BraveSoftware/Brave-Browser/Application/brave.exe`])
    : process.platform === "darwin" ? ["/Applications", `${env.HOME}/Applications`].flatMap((d) => [`${d}/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${d}/Chromium.app/Contents/MacOS/Chromium`, `${d}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
      `${d}/Brave Browser.app/Contents/MacOS/Brave Browser`])
    : [...(env.PATH ?? "").split(":"), "/snap/bin", "/var/lib/flatpak/exports/bin", `${env.HOME}/.local/share/flatpak/exports/bin`].flatMap((d) =>
      ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser",
        "com.google.Chrome", "org.chromium.Chromium"].map((b) => `${d}/${b}`));
  // CHROME_PATH (as Puppeteer and Lighthouse read it) names one anywhere.
  return [env.CHROME_PATH, ...list].find((p) => p && existsSync(p)) ?? null;
}
const browser = browserArg === "auto" ? findBrowser() : browserArg;
if (!browser) { process.stderr.write("Page needs Chrome, Edge or Chromium on this computer"); process.exit(1); }
const W = Math.max(320, Number(widthArg) || 780), MAX_H = 8000, SCALE = 2, WAIT = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(`${profile}/DevToolsActivePort`, { force: true });
const proc = spawn(browser, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions",
  // Chromium won't start as root (a Linux container) with its sandbox on.
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"],
  { stdio: "ignore", windowsHide: true });
const exited = new Promise((ok) => proc.once("exit", ok));
// The profile is this run's own (two viewers at once can't share one): gone with the browser.
let ending = false; // once: the socket's error as the browser goes is not news
const done = async (code, msg) => {
  if (ending) return new Promise(() => {});
  ending = true;
  if (msg) process.stderr.write(msg);
  try { proc.kill(); } catch {}
  await Promise.race([exited, sleep(3000)]);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => null);
  process.exit(code);
};
setTimeout(() => done(1, "The browser took too long"), WAIT + 10000);

let port = null;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(50);
  port = Number((await readFile(`${profile}/DevToolsActivePort`, "utf8").catch(() => "")).split("\n")[0]) || null;
}
if (!port) await done(1, "The browser didn't start");
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
  target = list.find((t) => t.type === "page");
  if (!target) await sleep(50);
}
if (!target) await done(1, "The browser has no page");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => { ws.onopen = ok; ws.onerror = () => done(1, "No connection to the browser"); });
let next = 0;
const waiting = new Map(), events = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id != null) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w?.bad(new Error(msg.error.message)) : w?.ok(msg.result); }
  else events.get(msg.method)?.(msg.params);
};
const send = (method, params = {}) => new Promise((ok, bad) => { const id = ++next; waiting.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })); });

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 600, deviceScaleFactor: SCALE, mobile: false });
  const loaded = new Promise((ok) => { events.set("Page.loadEventFired", ok); setTimeout(ok, WAIT); });
  const nav = await send("Page.navigate", { url });
  if (nav.errorText) throw new Error(`The page didn't load (${nav.errorText})`);
  await loaded;
  await send("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => 1) : 1", awaitPromise: true }).catch(() => null);
  await sleep(150); // a frame or two for what the load handlers start
  const m = await send("Page.getLayoutMetrics");
  const size = m.cssContentSize ?? m.contentSize;
  const h = Math.max(1, Math.min(MAX_H, Math.ceil(size.height)));
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: h, scale: 1 } });
  await writeFile(out, Buffer.from(shot.data, "base64"));
  process.stdout.write(`${W} ${h}${size.height > MAX_H ? " cut" : ""}\n`);
  await done(0);
} catch (e) { await done(1, String(e?.message ?? e)); }
