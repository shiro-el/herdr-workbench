// local change: what the tree's context menu does to files, on the machine they're on. Unix (and other machines)
// through sh, this Windows through PowerShell with .NET calls (no wildcards in names; -Command takes no arguments,
// so paths go in as single-quoted strings, quotes doubled). Each resolves with the new name, or throws its message.
import { exec, run, shared, setShared } from "herdr";
import { openFloat } from "./util.js";
import { hereOnWindows, psQuote, ps as runPs, openExternal, reveal, revealLabel } from "./common/platform.js";

export { hereOnWindows, reveal, revealLabel };
export const join = (root, path) => (path ? `${root}/${path}` : root);
const under = (folder, name) => (folder ? `${folder}/${name}` : name);
export const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const nameOf = (path) => path.split("/").pop();

async function sh(on, script, ...args) {
  const r = await exec("sh", ["-c", script, "t3-files", ...args], { on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "It didn't work").trim().split(/\r?\n/).pop());
  return r.stdout.trim();
}
async function ps(script) {
  const r = await runPs("try { " + script + " } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }");
  if (r.code !== 0) throw new Error((r.stderr || "It didn't work").trim().split(/\r?\n/).pop());
  return r.stdout.trim();
}
const q = (s) => "'" + psQuote(s) + "'";
const EXISTS = "A file or folder with this name already exists here";

// A name typed into the tree: may make folders on the way ("src/a.ts"), never climb out of its folder.
export function badName(name, onWindows) {
  const n = name.trim();
  if (!n) return "A name is needed";
  if (n.split("/").some((p) => p === "." || p === "..")) return "A name can't be . or ..";
  if (n.startsWith("/") || n.endsWith("/")) return "A name can't start or end with /";
  if (onWindows && /[\\:*?"<>|]/.test(n)) return 'A name can\'t have \\ : * ? " < > |';
  return null;
}

export async function create(root, on, folder, name, dir) {
  const full = join(root, under(folder, name.trim()));
  if (hereOnWindows(on)) await ps("$p = " + q(full) + "; if (Test-Path -LiteralPath $p) { throw '" + EXISTS + "' }; " +
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); " +
    (dir ? "[void][IO.Directory]::CreateDirectory($p)" : "[IO.File]::WriteAllBytes($p, [byte[]]@())"));
  else await sh(on, 'if [ -e "$1" ]; then echo "$3" >&2; exit 3; fi; mkdir -p -- "$(dirname -- "$1")" && if [ "$2" = d ]; then mkdir -- "$1"; else : > "$1"; fi',
    full, dir ? "d" : "f", EXISTS);
  return under(folder, name.trim());
}

export async function rename(root, on, path, name) {
  const from = join(root, path), to = join(root, under(parentOf(path), name.trim()));
  if (hereOnWindows(on)) await ps("$a = " + q(from) + "; $b = " + q(to) + "; " +
    "if ((Test-Path -LiteralPath $b) -and ($a.ToLower() -ne $b.ToLower())) { throw '" + EXISTS + "' }; " +
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($b)); Move-Item -LiteralPath $a -Destination $b");
  else await sh(on, 'if [ -e "$2" ]; then echo "$3" >&2; exit 3; fi; mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"', from, to, EXISTS);
  return under(parentOf(path), name.trim());
}

// Copies (or moves) each { path, folder } into its folder, as "name copy.ext", "name copy 2.ext"... when the name is
// taken there. One process for all of them (PowerShell alone takes ~0.4 s to start); the first failure stops the rest.
// Resolves with the new paths.
export async function place(root, on, jobs, move) {
  for (const { path, folder } of jobs) if (folder === path || folder.startsWith(path + "/")) throw new Error(nameOf(path) + ": a folder can't go inside itself");
  if (!jobs.length) return [];
  let got;
  if (hereOnWindows(on)) got = await ps("$srcs = @(" + jobs.map((j) => q(join(root, j.path))).join(", ") + "); $dirs = @(" + jobs.map((j) => q(join(root, j.folder))).join(", ") + "); " +
    "for ($i = 0; $i -lt $srcs.Count; $i++) { $src = $srcs[$i]; $dir = $dirs[$i]; $name = [IO.Path]::GetFileName($src); " +
    "try { $t = [IO.Path]::Combine($dir, $name); " +
    "if (Test-Path -LiteralPath $t) { $stem = [IO.Path]::GetFileNameWithoutExtension($name); $ext = [IO.Path]::GetExtension($name); " +
    "if (-not $stem) { $stem = $name; $ext = '' }; $t = [IO.Path]::Combine($dir, $stem + ' copy' + $ext); $n = 2; " +
    "while (Test-Path -LiteralPath $t) { $t = [IO.Path]::Combine($dir, $stem + ' copy ' + $n + $ext); $n++ } }; " +
    (move ? "Move-Item -LiteralPath $src -Destination $t" : "Copy-Item -LiteralPath $src -Destination $t -Recurse") +
    "; [Console]::WriteLine([IO.Path]::GetFileName($t)) } catch { throw ($name + ': ' + $_.Exception.Message) } }");
  else got = await sh(on, 'mode="$1"; shift; while [ $# -gt 1 ]; do src="$1"; dir="$2"; shift 2; name="${src##*/}"; t="$dir/$name"; ' +
    'if [ -e "$t" ]; then case "$name" in ?*.*) stem="${name%.*}"; ext=".${name##*.}";; *) stem="$name"; ext="";; esac; ' +
    't="$dir/$stem copy$ext"; n=2; while [ -e "$t" ]; do t="$dir/$stem copy $n$ext"; n=$((n+1)); done; fi; ' +
    'if [ "$mode" = move ]; then mv -- "$src" "$t"; else cp -R -- "$src" "$t"; fi || exit 1; printf "%s\\n" "${t##*/}"; done',
    move ? "move" : "copy", ...jobs.flatMap((j) => [join(root, j.path), join(root, j.folder)]));
  return got.split(/\r?\n/).filter(Boolean).map((n, i) => under(jobs[i].folder, n));
}

// To the Recycle Bin here; elsewhere the trash (gio, trash-put, macOS's trash), deleted for good where there's none. All in one
// process; resolves with "trash" | "gone" for each.
export async function remove(root, on, paths) {
  if (!paths.length) return [];
  const fulls = paths.map((p) => join(root, p));
  if (hereOnWindows(on)) {
    await ps("Add-Type -AssemblyName Microsoft.VisualBasic; $fs = [Microsoft.VisualBasic.FileIO.FileSystem]; " +
      "foreach ($p in @(" + fulls.map(q).join(", ") + ")) { try { " +
      "if ([IO.Directory]::Exists($p)) { $fs::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { $fs::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
      "} catch { throw ([IO.Path]::GetFileName($p) + ': ' + $_.Exception.Message) } }");
    return paths.map(() => "trash");
  }
  const out = await sh(on, 'if command -v gio >/dev/null 2>&1; then how=gio; elif command -v trash-put >/dev/null 2>&1; then how=tp; elif command -v trash >/dev/null 2>&1; then how=t; else how=rm; fi; ' +
    'for p in "$@"; do if [ "$how" = gio ] && gio trash -- "$p" 2>/dev/null; then echo trash; elif [ "$how" = tp ] && trash-put -- "$p"; then echo trash; ' +
    'elif [ "$how" = t ] && trash "$p" 2>/dev/null; then echo trash; ' +
    'else rm -rf -- "$p" || exit 1; echo gone; fi; done', ...fulls);
  return out.split(/\r?\n/).filter(Boolean);
}

// This computer's own app for a file. reveal() and revealLabel() are platform.js's.
export const openHere = (full) => openExternal(full);

export const openTerminal = (folder) => run("terminal.open", { folder, place: "tab" });

// The tree hears about a change (reload, open a folder) through shared state: the menu and the dialog are other copies.
export const TREE = "t3-files.tree", CLIP = "t3-files.clip", MENU_FOR = "t3-files.menu-for";
// { open: a folder to expand, collapse: a folder whose subfolders fold }; the tree reloads in any case.
export const tell = (root, on, what = {}) => setShared(TREE, { at: Date.now() + Math.random(), root, on: on ?? null, ...what });
export const clip = () => shared(CLIP) ?? null;
export const setClip = (v) => setShared(CLIP, v);
export const sameMachine = (a, b) => (a ?? null) === (b ?? null);
export { openFloat };
