// Copied from ~/.config/herdr-app/t3-common by sync.mjs: edit it there.
// Folders and paths on any machine: what's in a folder, what a path is.
// A mod's own fs reads only under home. Here, under home, it does; beyond it sh does on macOS and Linux,
// and node (fsq.mjs) or PowerShell on Windows. Another machine answers through its sh, or PowerShell
// when it has none.
import { exec, appHome } from "herdr";
import * as fsp from "fs/promises";
import { isWindows, ps, psQuote, slashes } from "./platform.js";
import { MOD } from "./where.js";

const FSQ = () => slashes(`${appHome()}/mods/${MOD}/common/fsq.mjs`);
const noSh = (e) => /cannot start sh|program not found/i.test(String(e?.message ?? e));
const nonAscii = /[^\x00-\x7f]/;
// "~" and "~/x" on that machine mean its home; sh expands them.
const HOME_SH = 'case "$p" in "~"|"~/"*) p="$HOME${p#"~"}";; esac; ';

// ── What's in a folder ──
// One folder per \001 record, then kind\0name\0 pairs.
const LIST_SH = (limit, skipGit) => 'for d in "$@"; do p=$d; ' + HOME_SH + 'printf "\\001%s\\0" "$d"; [ -d "$p" ] || { printf "!\\0"; continue; }; n=0; ' +
  'for e in "$p"/* "$p"/.[!.]* "$p"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; name=${e##*/}; ' +
  (skipGit ? '[ "$name" = .git ] && continue; ' : "") +
  `if [ -d "$e" ]; then k=d; else k=f; fi; printf "%s\\0%s\\0" "$k" "$name"; n=$((n+1)); [ "$n" -ge ${limit} ] && break; done; done`;
const psList = (limit, skipGit) => "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | " +
  (skipGit ? "Where-Object Name -ne '.git' | " : "") + `Select-Object -First ${limit} | ForEach-Object { @{ name=$_.Name; ` +
  // A link keeps its directory attribute when it dangles: its target decides. Other reparse points
  // (OneDrive's folders) have no LinkType and are folders.
  "dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or " +
  "($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress }";

async function listPs(dir, on, limit, skipGit) {
  const r = await ps(psList(limit, skipGit) + " '" + psQuote(dir) + "'", on);
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const got = JSON.parse(r.stdout || "[]");
  return (Array.isArray(got) ? got : [got]).map((e) => ({ name: e.name, dir: Boolean(e.dir) }));
}
async function listSh(dirs, on, limit, skipGit) {
  const r = await exec("sh", ["-c", LIST_SH(limit, skipGit), "fsx", ...dirs], on ? { on } : undefined);
  const out = new Map();
  for (const chunk of r.stdout.split("\x01").slice(1)) {
    const f = chunk.split("\0"), dir = f[0];
    if (f[1] === "!") { out.set(dir, null); continue; }
    const items = [];
    for (let i = 1; i + 1 < f.length; i += 2) items.push({ name: f[i + 1], dir: f[i] === "d" });
    out.set(dir, items);
  }
  return out;
}

/**
 * [{ name, dir }] in a folder, unsorted; throws when it can't be read.
 * opts.limit: at most so many (500); opts.skipGit: leave .git out.
 */
export async function list(dir, on, opts = {}) {
  const limit = opts.limit ?? 500, skipGit = Boolean(opts.skipGit);
  if (!on) {
    try {
      const items = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => !(skipGit && d.name === ".git")).slice(0, limit);
      // A link counts as what it points to (pnpm's node_modules are links to folders): one that opens is a folder.
      const opens = (d) => fsp.readdir(dir.endsWith("/") ? dir + d.name : `${dir}/${d.name}`).then(() => true, () => false);
      return Promise.all(items.map(async (d) => ({ name: d.name, dir: d.isDirectory() || (Boolean(d.isSymbolicLink?.()) && await opens(d)) })));
    } catch { /* beyond home: below */ }
    if (isWindows()) {
      const r = await exec("node", [FSQ(), "list", dir, String(limit), skipGit ? "1" : "0"]).catch(() => null);
      if (r?.code === 0) return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => ({ dir: l[0] === "d", name: l.slice(2) }));
      if (r && !/ENOENT|not found/i.test(r.stderr)) throw new Error(r.stderr.trim() || "Cannot list this folder");
      return listPs(dir, null, limit, skipGit); // no node here
    }
  }
  try {
    const got = (await listSh([dir], on, limit, skipGit)).get(dir);
    if (!got) throw new Error("Cannot list this folder");
    return got;
  } catch (e) {
    if (on && noSh(e)) return listPs(dir, on, limit, skipGit);
    throw e;
  }
}

/** Several folders in one round trip where it's another machine: Map dir -> entries, or null for one it couldn't read. */
export async function listMany(dirs, on, opts = {}) {
  const limit = opts.limit ?? 500, skipGit = Boolean(opts.skipGit);
  if (!on) {
    const got = await Promise.all(dirs.map((d) => list(d, null, opts).catch(() => null)));
    return new Map(dirs.map((d, i) => [d, got[i]]));
  }
  try { return await listSh(dirs, on, limit, skipGit); } catch (e) {
    if (!noSh(e)) throw e;
    const got = await Promise.all(dirs.map((d) => listPs(d, on, limit, skipGit).catch(() => null)));
    return new Map(dirs.map((d, i) => [d, got[i]]));
  }
}

// ── What a path is ──
const STAT_SH = 'for p in "$@"; do ' + HOME_SH + 'if [ -d "$p" ]; then k=d; elif [ -e "$p" ]; then k=f; else k=-; fi; printf "%s\\t%s\\n" "$k" "$p"; done';
const STAT_PS = "& { foreach ($p in $args) { $k = if (Test-Path -LiteralPath $p -PathType Container) { 'd' } elseif (Test-Path -LiteralPath $p) { 'f' } else { '-' }; " +
  "[Console]::Out.Write(\"$k`t$p`n\") } }";

async function statOnce(paths, on) {
  let r;
  if (!on && isWindows()) {
    r = await exec("node", [FSQ(), "stat", ...paths]).catch(() => null);
    if (!r || r.code !== 0) r = await ps(STAT_PS + " " + paths.map((p) => "'" + psQuote(p) + "'").join(" ")).catch(() => null);
  } else {
    r = await exec("sh", ["-c", STAT_SH, "fsx", ...paths], on ? { on } : undefined)
      .catch((e) => (on && noSh(e) ? ps(STAT_PS + " " + paths.map((p) => "'" + psQuote(p) + "'").join(" "), on).catch(() => null) : null));
  }
  const lines = (r?.stdout ?? "").split(/\r?\n/).filter(Boolean);
  return paths.map((_, i) => { const [kind, path] = (lines[i] ?? "-\t").split("\t"); return { kind: kind || "-", path: path || paths[i] }; });
}

/**
 * [{ kind: "d" | "f" | "-", path }] for each path, the path as that machine spells it ("~" expanded).
 * Text copied off a screen is NFC; a file macOS (HFS+) or a Mac's copy named is NFD: a miss with
 * letters beyond ASCII is tried that way too.
 */
export async function stat(paths, on) {
  if (!paths.length) return [];
  const got = await statOnce(paths, on);
  if (!on && isWindows()) return got;
  const retry = got.map((s, i) => (s.kind === "-" && nonAscii.test(paths[i]) && paths[i].normalize("NFD") !== paths[i] ? i : -1)).filter((i) => i >= 0);
  if (retry.length) {
    const again = await statOnce(retry.map((i) => paths[i].normalize("NFD")), on);
    retry.forEach((i, j) => { if (again[j].kind !== "-") got[i] = again[j]; });
  }
  return got;
}

/** For matching what's typed against names: one form (NFC), any case. */
export const fold = (s) => String(s).normalize("NFC").toLowerCase();
