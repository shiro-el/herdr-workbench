// Whole paths as typed or printed, with / for a separator on every OS. On Windows here a drive letter starts one
// ("C:/x") and Git Bash's "/c/x" means the same; elsewhere, and on another machine, "/" does.
import { home } from "herdr";
import { isWindows, slashes } from "./platform.js";

const DRIVE = /^[A-Za-z]:/;
/** "." and ".." worked out, doubled slashes gone, a drive letter upper-case. */
export function norm(s) {
  const drive = DRIVE.exec(s)?.[0] ?? "", rest = s.slice(drive.length), lead = rest.startsWith("/") ? "/" : "";
  const out = [];
  for (const part of rest.split("/")) { if (!part || part === ".") continue; if (part === "..") out.pop(); else out.push(part); }
  return (drive ? drive.toUpperCase() : "") + lead + out.join("/") || (drive ? drive.toUpperCase() + "/" : lead || ".");
}
export const isAbsolute = (s) => /^([A-Za-z]:[\\/]|[\\/]|~([\\/]|$))/.test(s);

/**
 * A path made whole against ctx.cwd on ctx.on: "file.ts:42" loses its line, "~" is home. Another machine's "~"
 * stays for its shell to expand (fsx does).
 */
export function resolve(text, ctx) {
  let s = text.trim().replace(/(?::\d+){1,2}$/, "");
  if (!ctx.on && isWindows()) {
    s = slashes(s);
    const gb = /^\/([a-zA-Z])(\/|$)/.exec(s);
    if (gb) s = `${gb[1]}:/${s.slice(3)}`;
  }
  if (s === "~" || s.startsWith("~/")) {
    if (ctx.on) return s.replace(/\/+$/, "") || "~";
    s = slashes(home()).replace(/\/+$/, "") + s.slice(1);
  }
  if (!(/^[A-Za-z]:\//.test(s) || s.startsWith("/"))) s = `${ctx.cwd}/${s}`;
  return norm(s);
}

/** The folder a path is in: "/" and "C:/" are their own. */
export function parentOf(p) {
  const i = p.lastIndexOf("/");
  if (i < 0) return p;
  if (i === 0) return "/";
  const up = p.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? up + "/" : up;
}
export const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);
export const join = (dir, name) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
/** `path` as relative to `root`, or null when it isn't under it. Windows here ignores case. */
export function under(root, path, on) {
  const r = root.replace(/\/+$/, "");
  const win = !on && isWindows(), a = win ? r.toLowerCase() : r, b = win ? path.toLowerCase() : path;
  return b.startsWith(a + "/") ? path.slice(r.length + 1) : null;
}
