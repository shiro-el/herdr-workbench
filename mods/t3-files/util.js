// What the tree and the floating viewer share: icons, reading a file's text, opening a file.
import { exec, readTextFile, writeTextFile, theme, settings, openOverlay, shared } from "herdr";
import { hereOnWindows, ps, psQuote, copyText } from "./common/platform.js";
import { EditorState } from "gpui-base";
import { createHash } from "crypto";
import MATERIAL from "./material-map.js";

export const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

// local change: Material Icon Theme's icon for a name, as VS Code picks it: the whole name, then its longest
// extension (component.test.tsx before tsx), else the plain file; a folder by its name. Light themes have their own.
export function materialIcon(name, dir, open) {
  const n = name.toLowerCase(), light = !settings().dark ? MATERIAL.light : null;
  const pick = (table) => (light?.[table]?.[n]) ?? MATERIAL[table][n];
  if (dir) return pick(open ? "foldersOpen" : "folders") ?? (open ? MATERIAL.folderOpen : MATERIAL.folder);
  const named = pick("names");
  if (named) return named;
  for (let i = n.indexOf("."); i >= 0; i = n.indexOf(".", i + 1)) {
    const ext = n.slice(i + 1);
    const hit = (light?.ext?.[ext]) ?? MATERIAL.ext[ext];
    if (ext && hit) return hit;
  }
  return MATERIAL.file;
}

// local change: a file that isn't UTF-8 (Korean Windows' CP949 / EUC-KR) is decoded as CP949 by the machine it's on.
export { psQuote };
export async function readLegacy(path, on) {
  const r = hereOnWindows(on)
    ? await ps("[Console]::Write([IO.File]::ReadAllText('" + psQuote(path) + "', [Text.Encoding]::GetEncoding(949)))")
    : await exec("iconv", ["-f", "CP949", "-t", "UTF-8", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "not CP949");
  return r.stdout;
}

// local change: a file's text for the viewer: { text, code, bom, legacy, editable, why } or { error }. With `edit` the
// code can be typed into, unless it was read as CP949 (saving writes UTF-8) or is over 1 MB (what readTextFile
// reads); `why` says which.
export async function readPreview(root, path, on, edit = false) {
  try {
    let text, legacy = false;
    try { text = await readTextFile(`${root}/${path}`, { on }); }
    catch { text = await readLegacy(`${root}/${path}`, on); legacy = true; }
    const bom = typeof text === "string" && text.charCodeAt(0) === 0xfeff;
    if (bom) text = text.slice(1);
    if (text === null) return { error: "This file is no longer available" };
    if (text.includes("\0")) return { error: "Binary file · no text preview" };
    const why = !edit ? null : legacy ? "Read only: read as CP949, and saving would make it UTF-8"
      : text.length > 400000 || utf8Length(text) > MAX_EDIT ? "Read only: over 1 MB" : null;
    const editable = edit && !why;
    const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
    return { text, bom, legacy, editable, why, code: EditorState.new({ language: LANG[ext] ?? ext, readonly: !editable,
      value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
      // JetBrains Mono, not the terminal font: a Nerd Font "Mono" (D2Coding's) gives Hangul one cell's width,
      // and the editor, which lays text out by advances, draws it overlapping.
      font_family: "JetBrains Mono", font_size: 12.5, soft_wrap: true,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } }) };
  } catch { return { error: "Cannot preview this file (binary, too large, or unreadable)" }; }
}

// local change: a file opens in a floating window over the layout. A click reuses one window (it stays where it
// was dropped); Ctrl-click (Cmd-click) gives the file a window of its own.
// The shared window while it holds unsaved changes isn't reused: the file gets its own.
export function openFloat(root, path, on, own) {
  own = own || Boolean(shared("t3-files.view-dirty"));
  openOverlay({ mod: "t3-files", kind: "window", key: own ? `t3-files:${on ?? ""}:${root}/${path}` : "t3-files:view",
    width: 780, height: 580, props: { viewer: { root, path, on, slot: !own } } });
}

export const copyPath = (text) => copyText(text);

export const MAX_EDIT = 1024 * 1024;
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

// UTF-8 bytes as base64, by hand: the runtime has no Buffer.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(s) {
  const b = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) b.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else b.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = b[i] << 16 | (b[i + 1] ?? 0) << 8 | (b[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < b.length ? B64[n >> 6 & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return out;
}

// local change: saves a file's text, refusing with "CHANGED" when the file is no longer `expected` (null: absent);
// `force` saves over whatever is there. Here writeTextFile does it. On another machine exec has no stdin: the text
// goes there base64 in pieces, then one sh call compares the file's sha256 with expected's and decodes the text over
// it, which keeps its mode and owner. Without sha256sum or shasum there, it saves unchecked.
const PIECE = 24000; // under Windows' 32K command line, should exec go through one
const FINAL = `if [ "$3" != force ] && { command -v sha256sum || command -v shasum; } >/dev/null 2>&1; then
  if [ "$3" = none ]; then [ -e "$2" ] && { echo CHANGED >&2; exit 3; }
  else cur=$( (sha256sum < "$2" 2>/dev/null || shasum -a 256 < "$2" 2>/dev/null) | cut -c1-64)
    [ "$cur" = "$3" ] || { echo CHANGED >&2; exit 3; }
  fi
fi
{ base64 -d < "$1" > "$1.out" 2>/dev/null || base64 -D < "$1" > "$1.out"; } && cat "$1.out" > "$2"`;
export async function saveText(full, text, expected, on, force = false) {
  if (!on) {
    try { return void await writeTextFile(full, text, force ? await readTextFile(full).catch(() => null) : expected); }
    catch (e) { throw /stale|changed|match/i.test(String(e?.message ?? e)) ? new Error("CHANGED") : e; }
  }
  const sh = async (script, ...args) => {
    const r = await exec("sh", ["-c", script, "sh", ...args], { on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `sh failed on ${on}`);
    return r.stdout;
  };
  const tmp = (await sh("mktemp")).trim();
  try {
    const b64 = base64(text);
    for (let i = 0; i === 0 || i < b64.length; i += PIECE) await sh('printf %s "$2" >> "$1"', tmp, b64.slice(i, i + PIECE));
    await sh(FINAL, tmp, full, force ? "force" : expected === null ? "none" : createHash("sha256").update(expected).digest("hex"));
  } finally { await exec("sh", ["-c", 'rm -f "$1" "$1.out"', "sh", tmp], { on }).catch(() => {}); }
}

