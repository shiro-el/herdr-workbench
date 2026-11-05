// A space's mark, as T3 Code's sidebar draws a project (ProjectFavicon): the project's own icon when it has
// one, else a two-letter monogram tinted with a color its name picks. One rule, with a copy in each mod that
// draws spaces (t3-inbox, t3-spaces, t3-new-menu, t3-tabs).
import { image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, appHome, settings, shared, setShared } from "herdr";
import { createHash } from "crypto";
import * as fs from "fs/promises";

// T3's project colors in its order, each as Tailwind's 400 (dark themes) and 600 (light).
const PALETTE = [
  ["#9ca3af", "#4b5563"], ["#f87171", "#dc2626"], ["#fb923c", "#ea580c"], ["#fbbf24", "#d97706"],
  ["#facc15", "#ca8a04"], ["#a3e635", "#65a30d"], ["#4ade80", "#16a34a"], ["#34d399", "#059669"],
  ["#2dd4bf", "#0d9488"], ["#22d3ee", "#0891b2"], ["#38bdf8", "#0284c7"], ["#60a5fa", "#2563eb"],
  ["#818cf8", "#4f46e5"], ["#a78bfa", "#7c3aed"], ["#c084fc", "#9333ea"], ["#e879f9", "#c026d3"],
  ["#f472b6", "#db2777"], ["#fb7185", "#e11d48"],
];

// The name's first letter or digit, capitalized: one glyph, where T3 spells two (a CJK pair only fits
// squeezed). A name without letters or digits (home's "~") spells nothing.
function monogram(name) {
  const first = name.normalize("NFKC").match(/[\p{L}\p{N}]/u)?.[0];
  return first ? [...first.toUpperCase()][0] : "";
}

// As T3: the name, folded, hashed into the palette, so a name has one color everywhere.
export function tint(name, dark) {
  const seed = name.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let i = 0;
  for (const g of seed) i = (i * 31 + g.codePointAt(0)) % PALETTE.length;
  return PALETTE[i][dark ? 0 : 1];
}

function isDark(t) {
  const hex = /^#([0-9a-f]{6})/i.exec(t.background ?? "");
  if (!hex) return true;
  const n = parseInt(hex[1], 16);
  return (n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 128;
}

// `ps`: panes(), read once by the caller (each read copies every pane).
export function projectMark(s, size, t, ps) {
  const icon = s && projectIcon(s, ps);
  if (icon) return image(icon).size(size).flex_none().rounded(size / 4);
  // No icon: a folder in the space's color, on a 14% wash of it, so marks look alike whatever the name's script.
  // Nothing to color by (home's "~"): T3's plain folder.
  if (!monogram(s?.name ?? "")) return h_flex().size(size).flex_none().items_center().justify_center()
    .child(svg("mods/workspace-chrome/folder.svg").size(size * 0.875).text_color(t.dim));
  const color = tint(s.name, isDark(t));
  return h_flex().size(size).flex_none().rounded(size / 4).bg(color + "24").items_center().justify_center()
    .child(svg("mods/workspace-chrome/folder.svg").size(size * 0.7).text_color(color));
}

// Icon files, by name, anywhere in the repo, tracked or not yet committed (ignored files, node_modules, builds stay out):
// no folder layout assumed. Names: favicon, icon, a name ending in -icon or _icon (aries-icon.svg), logo; svg, png, ico.
// Of several, the shallowest; then by that name order; then svg, png, ico; then the shortest name (aries-icon before
// aries-icon-small); then alphabetical.
const EXTS = [".svg", ".png", ".ico"];
const GLOBS = ["favicon.*", "icon.*", "*-icon.*", "*_icon.*", "logo.*"].map((g) => `:(glob,icase)**/${g}`);
const kind = (stem) => stem === "favicon" ? 0 : stem === "icon" ? 1 : /[-_]icon$/.test(stem) ? 2 : stem === "logo" ? 3 : -1;
const rank = (f) => {
  const name = f.slice(f.lastIndexOf("/") + 1).toLowerCase(), dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  return { ok: kind(stem) >= 0 && EXTS.includes(ext), r: [f.split("/").length, kind(stem), EXTS.indexOf(ext), name.length] };
};
const pick = (files) => files.map((f) => ({ f, ...rank(f) })).filter((x) => x.ok)
  .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.r[2] - y.r[2] || x.r[3] - y.r[3] || x.f.localeCompare(y.f))[0]?.f ?? null;

// The person's choice wins: `t3-icons.json` in the app's folder, { "<repo>": "<path in the repo>" }, the repo named by
// its main checkout's folder, so its worktrees share it (as `"my-app": "apps/web/app/icon.svg"`).
async function chosen(repo) {
  try { return JSON.parse((await readTextFile(`${appHome()}/t3-icons.json`)) ?? "{}")[repo] ?? null; } catch { return null; }
}

// The icon of the project a folder is in (its repo's top, as T3's project root), copied under the app's
// folder (images show only from there); null if it has none or isn't in a repo. All through exec, so another
// machine's space works the same.
async function lookUp(on, dir) {
  const top = await exec("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { cwd: dir, on });
  if (top.code !== 0) return null;
  const [root, common] = top.stdout.trim().split("\n").map((x) => x.trim());
  if (!root) return null;
  const main = (common ?? "").trim().replace(/[\\/]\.git[\\/]?$/, "");
  let hit = await chosen(main.slice(Math.max(main.lastIndexOf("/"), main.lastIndexOf("\\")) + 1));
  if (!hit) {
    const ls = await exec("git", ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard", "--", ...GLOBS], { cwd: root, on });
    if (ls.code !== 0) return null;
    hit = pick(ls.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
  }
  if (!hit || hit.split("/").includes("..")) return null;
  // This runtime writes a Uint8Array as an empty file, so bytes never go through fs.writeFile: an SVG is text
  // and is written as a string; a picture is decoded by this computer's own `base64 -d`.
  const ext = hit.slice(hit.lastIndexOf(".")).toLowerCase();
  let svgText = null, b64 = null;
  if (ext === ".svg") {
    svgText = await readTextFile(`${root}/${hit}`, { on });
    if (!svgText) return null;
  } else {
    const r = await exec("sh", ["-c", 'base64 < "$1"', "sh", hit], { cwd: root, on });
    if (r.code !== 0) return null;
    b64 = r.stdout.replace(/\s+/g, "");
    if (!b64) return null;
  }
  // Named by its content: a changed icon is a new file, so nothing keeps showing the old one.
  const name = `cache/t3-icons/${createHash("sha256").update(svgText ?? b64).digest("hex").slice(0, 16)}${ext}`;
  const path = `${appHome()}/${name}`;
  // fs has no stat, and reading a picture as text fails: ask this computer whether the file has bytes.
  const size = async () => { try { return (await fs.exists(path)) && (await exec("sh", ["-c", "test -s \"$1\"", "sh", path])).code === 0; } catch { return false; } };
  if (!(await size())) {
    await fs.mkdir(`${appHome()}/cache/t3-icons`, { recursive: true });
    if (svgText) await fs.writeFile(path, svgText);
    else await exec("sh", ["-c", 'printf %s "$1" | base64 -d > "$2"', "sh", b64, path]);
    if (!(await size())) return null;
  }
  return name;
}

// Where a space is now, as t3-spaces has it: its first terminal's live folder, else where it was made.
function placeOf(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps?.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// Shared "space.icons": [machine, folder] -> the copy's path or null, so every mod shows what one found.
// shortcut: folders no space uses any more stay listed; prune them if the list ever grows noticeably.
const looked = new Map(); // [machine, folder] -> when this copy last looked
function projectIcon(s, ps) {
  const folder = placeOf(s, ps);
  if (!folder) return null;
  const key = JSON.stringify([s.machine ?? null, folder]);
  const known = (shared("space.icons") ?? {})[key] ?? null;
  // Looked for again after a minute, found or not (T3 waits 10 minutes for a found one): an edited icon shows soon.
  if (!looked.has(key) || Date.now() - looked.get(key) > 60000) {
    looked.set(key, Date.now());
    lookUp(s.machine ?? null, folder).then((found) => {
      const all = shared("space.icons") ?? {};
      if ((all[key] ?? null) !== found) setShared("space.icons", { ...all, [key]: found });
    }, () => {}); // a machine away, no sh: the next look tries again
  }
  return known;
}
