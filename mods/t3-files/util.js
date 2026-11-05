// What the tree and the floating viewer share: icons, reading a file's text, opening a file.
import { exec, readTextFile, theme, settings, openOverlay } from "herdr";
import { hereOnWindows, ps, psQuote, copyText } from "./common/platform.js";
import { EditorState } from "gpui-base";
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

// local change: a file's text for the viewer: { code } or { error }.
export async function readPreview(root, path, on) {
  try {
    let text;
    try { text = await readTextFile(`${root}/${path}`, { on }); }
    catch { text = await readLegacy(`${root}/${path}`, on); }
    if (typeof text === "string" && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text === null) return { error: "This file is no longer available" };
    if (text.includes("\0")) return { error: "Binary file · no text preview" };
    const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
    return { text, code: EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
      value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
      // JetBrains Mono, not the terminal font: a Nerd Font "Mono" (D2Coding's) gives Hangul one cell's width,
      // and the editor, which lays text out by advances, draws it overlapping.
      font_family: "JetBrains Mono", font_size: 12.5, soft_wrap: true,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } }) };
  } catch { return { error: "Cannot preview this file (binary, too large, or unreadable)" }; }
}

// local change: a file opens in a floating window over the layout. A click reuses one window (it stays where it
// was dropped); Ctrl-click (Cmd-click) gives the file a window of its own.
export function openFloat(root, path, on, own) {
  openOverlay({ mod: "t3-files", kind: "window", key: own ? `t3-files:${on ?? ""}:${root}/${path}` : "t3-files:view",
    width: 780, height: 580, props: { viewer: { root, path, on } } });
}

export const copyPath = (text) => copyText(text);

