// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, props, openOverlay, closeOverlay, shared, appHome } from "herdr";
import { LANG, materialIcon, readLegacy, readPreview, openFloat, copyPath } from "./util.js";
import { list, listMany } from "./common/fsx.js";
import { Viewer } from "./viewer.js";
import { Menu, Ask, openMenu } from "./menu.js";
import { TREE, CLIP, MENU_FOR, sameMachine } from "./ops.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

// local change: common/fsx.js reads folders on every OS and machine (the runtime's own readdir under home first).
const LIST = { limit: 501, skipGit: true };
const directory = (path, on) => list(path, on, LIST);
// Several folders, for looking ahead: path -> entries (or null).
const directories = (paths, on) => listMany(paths, on, LIST);
const sortEntries = (list) => list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

export default class Files extends View {
  init(_props, cx) {
    // local change: this copy is the floating viewer (viewer.js) when opened with props.viewer.
    if (props()?.viewer) { this.part = new Viewer(props().viewer, cx); return; }
    // local change: and its right-click menu (props.menu) or the dialog that menu asks with (props.ask).
    if (props()?.menu) { this.part = new Menu(props().menu, cx); return; }
    if (props()?.ask) { this.part = new Ask(props().ask, cx); return; }
    // local change: t3-common's source copied into each mod's common/ when it changed (sync.mjs writes only what
    // differs; a mod it writes reloads). The tree is on screen from the start, so this runs when the app opens.
    cx.spawn(async () => { await exec("node", [`${appHome()}/t3-common/sync.mjs`.replace(/\\/g, "/")]).catch(() => null); });
    this.heard = shared(TREE)?.at;
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.ahead = new Map(); // folder -> entries read ahead (not shown, not counted until opened)
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  // local change: read the subfolders of a folder just listed, so opening one shows at once.
  // Awaited at the end of the task that listed it, after its redraw: nothing waits on it.
  async lookAhead(path, context) {
    const subs = (this.entries.get(path) ?? []).filter(e => e.dir).map(e => path ? `${path}/${e.name}` : e.name)
      .filter(p => !this.entries.has(p) && !this.ahead.has(p)).slice(0, 60);
    if (!subs.length || !this.current(context)) return;
    const { on, cwd: root } = context, abs = (p) => `${root}/${p}`;
    {
      try {
        const got = await directories(subs.map(abs), on);
        for (const p of subs) { const items = got.get(abs(p)); if (items && this.current(context)) this.ahead.set(p, sortEntries(items).slice(0, PER_FOLDER)); }
      } catch { /* a machine away: folders are read when opened */ }
    }
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.ahead = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.selected = new Set(); this.anchor = null; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        cx.notify();
        for (const path of ["", ...this.folders]) await this.lookAhead(path, context);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        // local change: a change heard while this read was going reads again.
        if (this.again) { this.again = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        if (this.entries.has(folder)) this.ahead.set(folder, this.entries.get(folder));
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      const early = this.ahead.get(path);
      if (early) { this.ahead.delete(path); this.entries.set(path, early); }
      if ((early || !this.entries.has(path)) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
          await this.lookAhead(path, context);
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        let text;
        try { text = await readTextFile(`${root}/${path}`, { on }); }
        catch { text = await readLegacy(`${root}/${path}`, on); }
        if (typeof text === "string" && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          // local change: JetBrains Mono, not the terminal font: a Nerd Font "Mono" (D2Coding's) gives Hangul one
          // cell's width, and the editor, which lays text out by advances, draws it overlapping. Wrapped: the panel is narrow.
          font_family: "JetBrains Mono", font_size: 12, soft_wrap: true,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const menuOn = this.menuFor === `${this.on ?? ""}|${this.root}|${path}`, cut = this.cut?.some(c => path === c || path.startsWith(c + "/"));
      const chosen = this.selected?.has(path);
      this.order.push(path); this.dirOf.set(path, entry.dir);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .border_1().border_color(menuOn ? t.accent : "#00000000").when(cut, el => el.opacity(0.5))
        .when(chosen, el => el.bg(t.selected))
        .on_click((e, cx) => this.click(path, entry.dir, e, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry.dir); })
        .child(entry.dir ? svg(`mods/t3-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(`mods/t3-files/material/${materialIcon(entry.name, entry.dir, open)}.svg`).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  async close() { this.part?.close(); this.code?.release?.(); }

  // local change: the right-click menu for a row ("" is the tree's folder itself), with the names it checks new ones against.
  // local change: VS Code's selection. A click picks one row (and opens it); Ctrl/Cmd-click adds or drops a row;
  // Shift-click picks the rows between the last picked one and this one, as they're shown (with Ctrl: added).
  click(path, dir, e, cx) {
    const m = e?.modifiers ?? {}, add = window()?.platform === "macos" ? m.platform : m.control;
    if (m.shift && this.anchor != null && this.order.includes(this.anchor)) {
      const a = this.order.indexOf(this.anchor), b = this.order.indexOf(path);
      if (!add) this.selected = new Set();
      for (const p of this.order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(p);
    } else if (add) {
      if (this.selected.has(path)) this.selected.delete(path); else this.selected.add(path);
      this.anchor = path;
    } else {
      this.selected = new Set([path]); this.anchor = path;
      if (dir) return this.toggle(path, cx);
      openFloat(this.root, path, this.on, false);
    }
    cx.notify();
  }

  menu(path, dir) {
    if (!this.root) return;
    // The right-clicked row among those picked: the menu is for all of them; else it picks that row alone.
    if (path && !this.selected.has(path)) { this.selected = new Set([path]); this.anchor = path; }
    const many = path ? this.order.filter(p => this.selected.has(p)).map(p => ({ path: p, dir: this.dirOf.get(p) })) : [];
    const names = (folder) => (this.entries.get(folder) ?? this.ahead.get(folder) ?? []).map(e => ({ name: e.name }));
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    openMenu({ root: this.root, on: this.on ?? null, path, dir, siblings: path ? names(parent) : [], inside: names(dir ? path : parent), many });
  }

  // local change: what the menu or its dialog changed (another copy): reload, open a folder, fold one's subfolders.
  hear(cx) {
    const m = shared(TREE);
    if (!m || m.at === this.heard) return;
    this.heard = m.at;
    if (m.root !== this.root || !sameMachine(m.on, this.on)) return;
    if (m.collapse != null) for (const f of [...this.folders]) if (!m.collapse || f.startsWith(m.collapse + "/")) { this.folders.delete(f); this.entries.delete(f); }
    if (m.open && !this.folders.has(m.open)) this.folders.add(m.open);
    if (Array.isArray(m.select)) { this.selected = new Set(m.select); this.anchor = null; }
    this.ahead = new Map();
    if (this.loading) this.again = true; else this.refresh(cx);
  }

  render(cx) {
    if (this.part) return this.part.render();
    if (key() !== this.context?.key) this.refresh(cx);
    this.hear(cx);
    const c = shared(CLIP);
    this.menuFor = shared(MENU_FOR); this.cut = c?.cut && c.root === this.root && sameMachine(c.on, this.on) ? (c.paths ?? [c.path]) : null;
    this.order = []; this.dirOf = new Map(); this.selected ??= new Set();
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", () => this.menu("", true)).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
