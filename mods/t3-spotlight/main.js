// local change (my mod): Ctrl+P, a Spotlight for what an agent just printed. Type a file path, a folder or a link
// (or pick one) and it opens here: a file in t3-files' viewer, a web page in its Page mode (Chromium draws it), a
// folder lists what's in it (Tab or Enter goes in) with a terminal there a row away. Empty, it lists the links and
// paths in the focused terminal's recent output, newest first. Paths resolve against that terminal's folder, on its
// machine. ↑/↓ to pick, Enter to open, Tab to complete, Esc to leave.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { hc, spaces, focused, panes, theme, props, closeOverlay, openOverlay, run, home, shared } from "herdr";
import { slashes, openExternal, reveal, revealLabel } from "./common/platform.js";
import { resolve, parentOf, nameOf, join, under, isAbsolute, fromFileUrl } from "./common/paths.js";
import { stat, list as listDir, fold } from "./common/fsx.js";

const HANGUL_TAIL = /[ㄱ-ㆎ가-힣]+$/; // a Hangul particle glued to the end of a path
const ICON = { file: "mods/t3-files/material/file.svg", dir: "mods/t3-files/material/folder.svg", url: "mods/t3-files/material/url.svg",
  browser: "mods/t3-files/material/http.svg", terminal: "mods/t3-files/material/console.svg", reveal: "mods/t3-files/material/folder-open.svg" };
const VISIBLE = 9, ROW = 38, LINES = 400;

// Where the focused terminal is (as t3-files' tree finds it), taken when the popup opens.
function here() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space?.folder || home();
  return { cwd: on ? cwd : slashes(cwd), on, terminal: f?.terminal ?? pane?.terminal ?? null };
}

// ── Reading what was printed ──
function pathLike(s) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  if (/^[A-Za-z]:[\\/]/.test(s) || /^~([\\/]|$)/.test(s)) return true;
  if (/[\\/]/.test(s)) return /\w/.test(s) && !s.includes("//");
  return /^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}$/.test(s); // "viewer.js", "main.rs:42"
}
const clean = (s) => s.replace(/[.,:;!?…]+$/, "");
// Links and paths in order of appearance; the newest wins a duplicate and comes first.
export function harvest(text) {
  const found = [];
  for (const raw of text.split(/[\s"'`<>()[\]{}|,;*]+/)) {
    if (raw.length < 3 || raw.length > 500) continue;
    // A file:// link is the file it names.
    const file = /file:\/\/\S+/i.exec(raw)?.[0], named = file && fromFileUrl(clean(file));
    if (named) { found.push({ kind: "path", text: named }); continue; }
    const url = /https?:\/\/\S+/i.exec(raw)?.[0];
    if (url) { found.push({ kind: "url", text: clean(clean(url).replace(HANGUL_TAIL, "")) }); continue; }
    const t = clean(raw), bare = clean(t.replace(HANGUL_TAIL, ""));
    for (const c of new Set([t, bare])) if (c && pathLike(c)) found.push({ kind: "path", text: c });
  }
  const seen = new Set(), out = [];
  for (const f of found.reverse()) if (!seen.has(f.text)) { seen.add(f.text); out.push(f); }
  return out;
}

// ── Paths ── (common/paths.js and common/fsx.js)
// [{ name, dir }], folders first; null when it can't be read.
async function list(dir, on) {
  const items = await listDir(dir, on, { limit: 3000 }).catch(() => null);
  return items && items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// ── Links ──
function asUrl(q) {
  const s = q.trim();
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/\S*)?$/i.test(s)) return `http://${s}`;
  const site = /^(?:www\.)?[\w-]+(?:\.[\w-]+)*\.([a-z]{2,})(?::\d+)?(?:\/\S*)?$/i.exec(s);
  if (site && (s.includes("/") || !FILE_EXT.has(site[1].toLowerCase()))) return `https://${s}`;
  return null;
}
// "viewer.js" is a file being typed, not a site: a name ending like these needs a path or https:// to be a link.
const FILE_EXT = new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "mdx", "txt", "html", "htm", "css", "scss", "py", "rs",
  "go", "rb", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "sh", "ps1", "bat", "yml", "yaml", "toml", "ini", "lock", "log",
  "csv", "tsv", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "sql", "env", "vue", "svelte", "lua", "php", "dart"]);
const openBrowser = (url) => void openExternal(url);
// t3-files' floating viewer (same spot and key as the tree's), for a file or a web page.
// One holding unsaved changes isn't reused: the file gets its own.
function view(viewer) {
  const own = Boolean(shared("t3-files.view-dirty")), what = viewer.url ?? `${viewer.on ?? ""}:${viewer.root}/${viewer.path}`;
  openOverlay({ mod: "t3-files", kind: "window", key: own ? `t3-files:${what}` : "t3-files:view", width: 780, height: 580,
    props: { viewer: { ...viewer, slot: !own } } });
}

export default class Spotlight extends View {
  init(_props, cx) {
    this.ctx = here();
    this.input = InputState.new({ placeholder: "File, folder or link" });
    this.input.on("change", (_e, cx) => this.changed(cx));
    // Enter before the rows caught up with the typing acts on the new first row, not on what was there before.
    this.input.on("submit", (_e, cx) => { if (this.rowsSeq === this.seq) this.act(this.rows[this.at], cx); else { this.submitted = this.seq; this.compute(cx); } });
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.rows = []; this.recent = []; this.at = 0; this.seq = 0; this.rowsSeq = -1; this.submitted = null; this.busy = true; this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { await this.readTerminal(); this.compute(cx); });
  }

  close() { closeOverlay(props()?.overlay); }

  // The focused terminal's last lines: links as they are, paths only where they exist.
  async readTerminal() {
    const { terminal, on } = this.ctx;
    if (!terminal) return;
    const r = await hc(["read", terminal, "--lines", String(LINES)]).catch(() => null);
    const got = harvest(r?.stdout ?? "").slice(0, 120);
    const paths = got.filter((g) => g.kind === "path"), seen = await stat(paths.map((g) => resolve(g.text, this.ctx)), on);
    const where = new Map(paths.map((g, i) => [g, seen[i]]));
    // An agent prints paths relative to where it works, which may not be the terminal's folder: a relative one not
    // found there is tried under the folders (and their parents) of the absolute paths the same output has.
    const bases = [...new Set(paths.flatMap((g) => {
      const s = where.get(g);
      if (!isAbsolute(g.text) || !s || s.kind === "-") return [];
      const up = []; let d = s.kind === "d" ? s.path : parentOf(s.path);
      for (let i = 0; i < 4 && d && !up.includes(d); i++) { up.push(d); d = parentOf(d); }
      return up;
    }))].filter((b) => b !== this.ctx.cwd).slice(0, 12);
    const lost = paths.filter((g) => !isAbsolute(g.text) && where.get(g)?.kind === "-").slice(0, 40);
    if (bases.length && lost.length) {
      const tries = lost.flatMap((g) => bases.map((b) => ({ g, p: resolve(g.text, { ...this.ctx, cwd: b }) })));
      const found = await stat(tries.map((x) => x.p), on);
      tries.forEach((x, i) => { if (found[i].kind !== "-" && where.get(x.g)?.kind === "-") where.set(x.g, found[i]); });
    }
    const shown = new Set();
    this.recent = got.flatMap((g) => {
      if (g.kind === "url") return [{ kind: "url", url: g.text, label: g.text, detail: "Link on screen" }];
      const s = where.get(g);
      if (!s || s.kind === "-" || shown.has(s.path)) return [];
      shown.add(s.path);
      return [{ kind: s.kind === "d" ? "dir" : "file", path: s.path, label: g.text, detail: s.kind === "d" ? "Folder on screen" : "File on screen" }];
    }).slice(0, 60);
  }

  changed(cx) {
    const seq = ++this.seq;
    cx.timer.after(110, (cx) => { if (seq === this.seq) this.compute(cx); });
  }

  compute(cx) {
    const q = this.input.value(), seq = this.seq;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const rows = await this.rowsFor(q).catch((e) => [{ kind: "note", label: String(e?.message ?? e) }]);
      if (seq !== this.seq) return;
      this.rows = rows; this.rowsSeq = seq; this.at = 0; this.busy = false; cx.notify();
      if (this.submitted === seq) { this.submitted = null; this.act(rows[0], cx); }
    });
  }

  async rowsFor(q) {
    const { on } = this.ctx, typed = q.trim(), text = fromFileUrl(typed) ?? typed, low = fold(text);
    const recent = this.recent.filter((r) => !low || fold(r.label).includes(low) || fold(r.path ?? r.url).includes(low));
    if (!text) return recent;
    const top = [], url = /^https?:\/\//i.test(text) ? text : null, domain = url ? null : asUrl(text);
    let exact = false;
    if (!url) {
      const full = resolve(text, this.ctx), [s] = await stat([full], on), path = s.path;
      exact = s.kind !== "-";
      if (s.kind === "d") {
        top.push({ kind: "terminal", path, label: "Open a terminal here", detail: path });
        if (!on) top.push({ kind: "reveal", path, dir: true, label: revealLabel(true), detail: path });
        const items = (await list(path, on)) ?? [];
        top.push(...items.slice(0, 300).map((e) => ({ kind: e.dir ? "dir" : "file", path: join(path, e.name), label: e.name + (e.dir ? "/" : ""), detail: "" })));
      } else if (s.kind === "f") {
        top.push({ kind: "file", path, label: nameOf(path), detail: path });
        if (!on) top.push({ kind: "reveal", path, dir: false, label: revealLabel(false), detail: path });
      } else if (!text.endsWith("/") && !domain) {
        // Not there (yet): what's in its folder that starts with (or has) what's typed.
        const dir = parentOf(path), part = fold(nameOf(path)), items = part ? await list(dir, on) : null;
        if (items) {
          // Names compare in one Unicode form: macOS spells Hangul names decomposed.
          const starts = items.filter((e) => fold(e.name).startsWith(part)), has = items.filter((e) => !fold(e.name).startsWith(part) && fold(e.name).includes(part));
          top.push(...[...starts, ...has].slice(0, 300).map((e) => ({ kind: e.dir ? "dir" : "file", path: join(dir, e.name), label: e.name + (e.dir ? "/" : ""), detail: dir })));
        }
      }
    }
    // "google.com" is a site unless a file of that name is right here.
    const link = url ?? (exact ? null : domain);
    if (link) {
      top.unshift({ kind: "url", url: link, label: link, detail: "Open here" },
        { kind: "browser", url: link, label: "Open in browser", detail: link });
    }
    const seen = new Set(top.map((r) => r.path ?? r.url));
    return [...top, ...recent.filter((r) => !seen.has(r.path ?? r.url))];
  }

  // Into a folder: the input becomes it, so typing goes on from there.
  enter(path, dir, cx) {
    this.input.set_value(path + (dir && !path.endsWith("/") ? "/" : ""));
    this.input.focus();
    this.changed(cx);
  }

  act(r, cx) {
    if (!r || r.kind === "note") return;
    const { on, cwd } = this.ctx;
    if (r.kind === "dir") return this.enter(r.path, true, cx);
    this.close();
    if (r.kind === "file") {
      const rel = under(cwd, r.path, on);
      view(rel ? { root: cwd.replace(/\/+$/, ""), path: rel, on } : { root: parentOf(r.path), path: nameOf(r.path), on });
    } else if (r.kind === "url") view({ url: r.url });
    else if (r.kind === "browser") openBrowser(r.url);
    else if (r.kind === "terminal") run("terminal.open", { folder: r.path, place: "tab" });
    else if (r.kind === "reveal") reveal(r.path, r.dir);
  }

  render() {
    const t = theme(), rows = this.rows, n = rows.length;
    this.at = Math.max(0, Math.min(this.at, n - 1));
    const start = Math.max(0, Math.min(this.at - Math.floor(VISIBLE / 2), n - VISIBLE));
    const shown = rows.slice(start, start + VISIBLE);
    const row = (r, i) => {
      const sel = start + i === this.at;
      if (r.kind === "note") return div().px(12).py(10).text_size(12).text_color(t.dim).child(r.label);
      return h_flex().id(`sp-${start + i}`).h(ROW).flex_none().mx(4).px(10).gap(10).items_center().rounded(7).cursor_pointer()
        .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(sel ? t.selected : t.hover))
        .on_click((_e, cx) => { this.at = start + i; this.act(r, cx); })
        .child(image(ICON[r.kind] ?? ICON.file).size(16).flex_none())
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).text_color(t.foreground).child(r.label))
          .when(Boolean(r.detail), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(r.detail))))
    };
    const empty = !this.busy && !n;
    return v_flex().id("spotlight").size_full().p(8).gap(8).bg(t.popover ?? t.background).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.key, r = rows[this.at];
        if (k === "escape") return this.close();
        if (k === "down" && n) this.at = (this.at + 1) % n;
        else if (k === "up" && n) this.at = (this.at + n - 1) % n;
        else if (k === "tab" && r && (r.kind === "dir" || r.kind === "file" || r.kind === "url")) {
          if (r.kind === "url") { this.input.set_value(r.url); this.changed(cx); } else this.enter(r.path, r.kind === "dir", cx);
        } else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.ctx.on ? `${this.ctx.on}` : "")))
      .child(v_flex().id("sp-list").h(VISIBLE * ROW).flex_none().overflow_hidden() // a popup is as tall as what it holds
        .on_scroll_wheel((e, cx) => { if (!n) return; this.at = Math.max(0, Math.min(n - 1, this.at + (e.delta.y < 0 ? 1 : -1))); cx.notify(); })
        .when(empty, (e) => e.child(div().px(12).py(10).text_size(12).text_color(t.dim)
          .child(this.input.value().trim() ? "Nothing found" : "No links or paths on screen")))
        .children(shown.map(row)))
      .child(h_flex().flex_none().px(6).gap(12).text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child(this.ctx.cwd))
        .child(div().flex_none().child(n ? `${this.at + 1}/${n}` : this.busy ? "…" : ""))
        .child(div().flex_none().child("↑↓ · Enter · Tab · Esc")));
  }
}
