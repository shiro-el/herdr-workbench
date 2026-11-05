// Copied from ~/.config/herdr-app/t3-common by sync.mjs: edit it there.
// What depends on the OS of this computer: one place for every branch on window().platform.
// Another machine (`on`) is always reached through its sh; only work done here looks at this OS.
// Source in ~/.config/herdr-app/t3-common; `node t3-common/sync.mjs` copies it into each mod's common/.
import { exec, window, notify } from "herdr";

/** "windows" | "macos" | "linux" for this computer. */
export const os = () => window()?.platform ?? "linux";
export const isWindows = () => os() === "windows";
export const isMac = () => os() === "macos";
/** Work on this computer, and it's Windows: PowerShell instead of sh. */
export const hereOnWindows = (on) => !on && isWindows();

export const slashes = (s) => String(s).replace(/\\/g, "/");
/** The path as this computer's own programs want it: backslashes on Windows. */
export const native = (p) => (isWindows() ? String(p).replace(/\//g, "\\") : String(p));

// Inside a PowerShell single-quoted string (-Command takes no arguments of its own): quotes doubled,
// curly single quotes too, since PowerShell reads them as quotes.
export const psQuote = (s) => String(s).replace(/['‘’‚‛]/g, "$&$&");
const psArgs = (script) => ["-NoProfile", "-NonInteractive", "-Command",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " + script];
/** Runs a PowerShell script here (or on a Windows machine without sh); UTF-8 out. */
export const ps = (script, on) => exec("powershell", psArgs(script), on ? { on } : undefined);

const quiet = (p) => p.catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
// cmd's start reads & ^ | < > itself.
const cmdStart = (target) => quiet(exec("cmd", ["/c", "start", "", String(target).replace(/[&^|<>]/g, "^$&")]));

/** A file, folder or address in this computer's own app for it. */
export function openExternal(target) {
  if (isWindows()) return cmdStart(/^[a-z][a-z0-9+.-]+:/i.test(target) ? target : native(target));
  if (isMac()) return quiet(exec("open", [String(target)]));
  return quiet(exec("sh", ["-c", 'xdg-open "$1" >/dev/null 2>&1 &', "sh", String(target)]));
}

const parentOf = (p) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "/"; };
/** A folder in the file manager, or a file shown selected in its folder. */
export function reveal(path, dir) {
  if (isWindows()) return quiet(exec("explorer", [dir ? native(path) : "/select," + native(path)]));
  if (isMac()) return quiet(exec("open", dir ? [path] : ["-R", path]));
  if (dir) return openExternal(path);
  // The freedesktop file manager interface selects the file (Nautilus, Dolphin, Nemo, Thunar); without it, the folder.
  const uri = "file://" + encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return quiet(exec("sh", ["-c", 'dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 --type=method_call ' +
    '/org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:"$1" string:"" >/dev/null 2>&1 || ' +
    '{ xdg-open "$2" >/dev/null 2>&1 & }', "sh", uri, parentOf(path)]));
}
/** The menu label for reveal(): a folder opens, a file is shown in its folder. */
export function revealLabel(dir) {
  const app = isWindows() ? "File Explorer" : isMac() ? "Finder" : "file manager";
  return dir ? `Open in ${app}` : isWindows() || isMac() ? `Reveal in ${app}` : `Show in ${app}`;
}

/** Text onto this computer's clipboard. Linux needs wl-copy or xclip; without them, a toast says so. */
export async function copyText(text) {
  const r = isWindows() ? await quiet(ps("Set-Clipboard -Value '" + psQuote(text) + "'"))
    : isMac() ? await quiet(exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", String(text)]))
    : await quiet(exec("sh", ["-c", 'if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then printf %s "$1" | wl-copy; ' +
      'elif command -v xclip >/dev/null 2>&1; then printf %s "$1" | xclip -selection clipboard; ' +
      'elif command -v xsel >/dev/null 2>&1; then printf %s "$1" | xsel --clipboard --input; ' +
      'elif command -v wl-copy >/dev/null 2>&1; then printf %s "$1" | wl-copy; else exit 127; fi', "sh", String(text)]));
  if (r.code === 0) return true;
  notify({ title: "Couldn't copy", level: "warning",
    body: r.code === 127 ? "Copying here needs wl-copy, xclip or xsel" : (r.stderr || "The clipboard didn't take it").trim().split(/\r?\n/).pop() });
  return false;
}

/** python 3 by the name it has there: "python" on Windows here, "python3" elsewhere. */
export const pythonCmd = (on) => (hereOnWindows(on) ? "python" : "python3");

/**
 * Starts a program here with no window that outlives the call; resolves with its pid, or null.
 * Windows: Start-Process, hidden. Elsewhere the program has to put itself in the background (ssh -f does),
 * and `match`, a piece of its command line, finds its pid afterwards.
 */
export async function startHidden(cmd, args, match) {
  if (isWindows()) {
    const r = await quiet(ps(`(Start-Process ${cmd} -WindowStyle Hidden -PassThru -ArgumentList '${args.map(psQuote).join("','")}').Id`));
    return Number(r.stdout.trim()) || null;
  }
  const r = await quiet(exec("sh", ["-c", 'm=$1; shift; "$@" >/dev/null 2>&1 </dev/null || exit 1; pgrep -n -f -- "$m" 2>/dev/null || true',
    "sh", match, cmd, ...args]));
  return r.code === 0 ? Number(r.stdout.trim()) || null : null;
}

/** Ends a program startHidden() started. */
export const killPid = (pid) => quiet(isWindows() ? exec("taskkill", ["/PID", String(pid), "/F"]) : exec("kill", [String(pid)]));
