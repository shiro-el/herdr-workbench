// local change: the tree's right-click menu (a pointer popup) and the dialog it asks names and deletes with. Both are
// copies of this mod opened as overlays (props.menu / props.ask); what they change, the tree hears through shared state.
// Items follow VS Code's Explorer: open, new, reveal, terminal; cut/copy/paste/duplicate; copy paths; rename, delete.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, notify, setShared, shared, window } from "herdr";
import { copyPath } from "./util.js";
import { join, parentOf, nameOf, hereOnWindows, badName, create, rename, place, remove, openHere, reveal, revealLabel,
  openTerminal, tell, clip, setClip, sameMachine, openFloat, MENU_FOR } from "./ops.js";

const failed = (title, e) => notify({ title, body: String(e?.message ?? e), level: "error" });
const NL = String.fromCharCode(10);
const icon = (name) => `mods/workspace-chrome/${name}.svg`;

export function openMenu(target) {
  setShared(MENU_FOR, `${target.on ?? ""}|${target.root}|${target.path}`);
  openOverlay({ mod: "t3-files", kind: "popup", width: 250, height: 560, props: { menu: target } });
}
const ask = (op, target) => openOverlay({ mod: "t3-files", kind: "dialog", width: 420, height: op === "delete" ? 180 : 170, props: { ask: { op, ...target } } });

// What a menu acts on: the rows selected (when the one right-clicked is among them), else that row. A folder's
// selected insides go with it, so they're dropped.
export const picked = (m) => {
  const all = m.many?.length > 1 ? m.many : [{ path: m.path, dir: m.dir }];
  return all.filter((x) => !all.some((y) => y.dir && y.path !== x.path && x.path.startsWith(y.path + "/")));
};
const clipPaths = (c) => c?.paths ?? (c?.path ? [c.path] : []);

function items(m) {
  const { root, on, path, dir } = m, here = !on, full = join(root, path), folder = dir ? path : parentOf(path), top = path === "";
  const c = clip(), canPaste = c && sameMachine(c.on, on) && c.root === root && clipPaths(c).length;
  const sep = "-", many = picked(m), n = many.length, abs = (p) => (hereOnWindows(on) ? join(root, p).replace(/\//g, "\\") : join(root, p));
  const pasteLabel = () => { const ps = clipPaths(c); return `Paste ${ps.length > 1 ? ps.length + " items" : nameOf(ps[0])}${c.cut ? " (move)" : ""}`; };
  const keep = (list) => list.filter((it, i, all) => it !== sep || (i > 0 && all[i - 1] !== sep && i < all.length - 1));
  if (n > 1) {
    const files = many.filter((x) => !x.dir);
    return keep([
      { label: `${n} selected`, header: true },
      ...(files.length ? [{ label: files.length > 1 ? `Open ${files.length} files` : "Open", icon: "file-text", act: () => files.forEach((x) => openFloat(root, x.path, on, true)) }, sep] : []),
      { label: "Cut", act: () => setClip({ root, on: on ?? null, paths: many.map((x) => x.path), cut: true }) },
      { label: "Copy", act: () => setClip({ root, on: on ?? null, paths: many.map((x) => x.path), cut: false }) },
      { label: "Duplicate", act: () => duplicate(m, many) },
      sep,
      { label: "Copy Paths", act: () => copyPath(many.map((x) => abs(x.path)).join(NL)) },
      { label: "Copy Relative Paths", act: () => copyPath(many.map((x) => x.path).join(NL)) },
      { label: "Copy Names", act: () => copyPath(many.map((x) => nameOf(x.path)).join(NL)) },
      sep,
      { label: `Delete ${n} items`, icon: "x", danger: true, act: () => ask("delete", { ...m, many }) },
    ]);
  }
  return keep([
    ...(!dir ? [
      { label: "Open", icon: "file-text", act: () => openFloat(root, path, on, false) },
      { label: "Open in new window", act: () => openFloat(root, path, on, true) },
      ...(here ? [{ label: "Open with default app", act: () => openHere(full) }] : []),
      sep] : []),
    ...(dir ? [
      { label: "New File…", icon: "file-text", act: () => ask("new-file", m) },
      { label: "New Folder…", icon: "folder-plus", act: () => ask("new-folder", m) },
      sep] : []),
    ...(here ? [{ label: revealLabel(dir), icon: "folder", act: () => reveal(full, dir) }] : []),
    { label: "Open in Terminal", icon: "terminal", act: () => openTerminal(join(root, folder)) },
    sep,
    ...(!top ? [
      { label: "Cut", act: () => setClip({ root, on: on ?? null, paths: [path], cut: true }) },
      { label: "Copy", act: () => setClip({ root, on: on ?? null, paths: [path], cut: false }) }] : []),
    ...(canPaste ? [{ label: pasteLabel(), act: () => paste(m, c) }] : []),
    ...(!top ? [{ label: "Duplicate", act: () => duplicate(m, many) }] : []),
    sep,
    { label: "Copy Path", act: () => copyPath(abs(path)) },
    ...(!top ? [{ label: "Copy Relative Path", act: () => copyPath(path) }, { label: "Copy Name", act: () => copyPath(nameOf(path)) }] : []),
    ...(dir ? [sep,
      ...(top ? [{ label: "Refresh", act: () => tell(root, on) }] : []),
      { label: top ? "Collapse All" : "Collapse Folders Inside", act: () => tell(root, on, { collapse: path }) }] : []),
    ...(!top ? [sep,
      { label: "Rename…", icon: "square-pen", act: () => ask("rename", m) },
      { label: "Delete", icon: "x", danger: true, act: () => ask("delete", m) }] : []),
  ]);
}

// All in one process (ops.js); the first failure stops the rest and names it. The tree reloads either way.
async function paste(m, c) {
  const folder = m.dir ? m.path : parentOf(m.path);
  try {
    const made = await place(m.root, m.on, clipPaths(c).map((path) => ({ path, folder })), c.cut);
    if (c.cut) setClip(null);
    tell(m.root, m.on, { open: folder, select: made });
  } catch (e) { failed(c.cut ? "Couldn't move" : "Couldn't paste", e); tell(m.root, m.on, { open: folder }); }
}
async function duplicate(m, many) {
  try { tell(m.root, m.on, { select: await place(m.root, m.on, many.map((x) => ({ path: x.path, folder: parentOf(x.path) })), false) }); }
  catch (e) { failed("Couldn't duplicate", e); tell(m.root, m.on); }
}

export class Menu {
  constructor(m, cx) {
    this.m = m; this.at = -1;
    this.handle = cx.focus_handle(); this.handle.focus();
  }

  close() { if (shared(MENU_FOR) === `${this.m.on ?? ""}|${this.m.root}|${this.m.path}`) setShared(MENU_FOR, null); }

  // The work first, then the popup closes: a closing copy's unfinished tasks are cancelled.
  choose(it, cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async () => {
      try { await it.act(); } catch (e) { failed(it.label, e); }
      closeOverlay(props()?.overlay);
    });
  }

  render() {
    const t = theme(), list = items(this.m), actions = list.filter((it) => it !== "-" && !it.header);
    const move = (d) => { this.at = (this.at + d + actions.length) % actions.length; };
    let n = -1;
    return v_flex().id("files-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") move(1);
        else if (e.key === "up") move(this.at < 0 ? 0 : -1);
        else if (e.key === "enter" && actions[this.at]) return this.choose(actions[this.at], cx);
        else if (e.key === "escape") return closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => {
        if (it === "-") return div().id(`fm-sep-${i}`).mx(7).my(4).h(1).flex_none().bg(t.border);
        if (it.header) return div().id(`fm-head-${i}`).h(24).flex_none().px(8).flex().items_center().text_size(11.5).text_color(t.dim).child(it.label);
        const k = ++n;
        return h_flex().id(`fm-${i}`).h(28).flex_none().px(8).gap(9).rounded(6).items_center()
          .text_color(it.danger ? t.ansi1 : t.foreground)
          .when(k === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => this.choose(it, cx))
          .child(it.icon ? svg(icon(it.icon)).size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted) : div().w(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .when(Boolean(it.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint)));
      }));
  }
}

// Asks for a name (new file, new folder, rename) or whether to delete. Enter does it, Esc cancels.
export class Ask {
  constructor(a, cx) {
    this.a = a; this.busy = false; this.error = null;
    this.handle = cx.focus_handle();
    if (a.op === "delete") { this.handle.focus(); return; }
    const value = a.op === "rename" ? nameOf(a.path) : "";
    this.text = value;
    this.input = InputState.new({ value });
    // Like VS Code, a rename selects the name without its extension.
    const dot = value.lastIndexOf(".");
    if (value) this.input.set_selected_range({ start: 0, end: !a.dir && dot > 0 ? dot : value.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  close() {}

  folder() { return this.a.op === "rename" ? parentOf(this.a.path) : this.a.dir ? this.a.path : parentOf(this.a.path); }

  problem() {
    if (this.a.op === "delete") return null;
    const name = (this.text ?? "").trim(), bad = badName(name, hereOnWindows(this.a.on));
    if (bad) return name ? bad : "";
    if (this.a.op === "rename" && name === nameOf(this.a.path)) return "";
    const first = name.split("/")[0], taken = (this.a.op === "rename" ? this.a.siblings : this.a.inside) ?? [];
    if (!name.includes("/") && taken.some((e) => e.name === first)) return `"${first}" already exists here`;
    return null;
  }

  submit(cx) {
    if (this.busy || this.problem() !== null) return;
    const a = this.a, name = (this.text ?? "").trim();
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (a.op === "delete") {
          const list = picked(a).map((x) => x.path), gone = [];
          try { (await remove(a.root, a.on, list)).forEach((how, i) => { if (how === "gone") gone.push(nameOf(list[i])); }); }
          finally {
            const c = clip(), under = (q) => list.some((p) => q === p || q.startsWith(p + "/"));
            if (c && sameMachine(c.on, a.on) && c.root === a.root && clipPaths(c).some(under)) setClip(null);
            tell(a.root, a.on, { select: [] });
          }
          if (gone.length) notify({ title: `Deleted ${gone.length > 1 ? gone.length + " items" : gone[0]}`, body: "That machine has no trash: it's gone for good.", level: "info" });
        } else if (a.op === "rename") {
          await rename(a.root, a.on, a.path, name); tell(a.root, a.on);
        } else {
          const made = await create(a.root, a.on, this.folder(), name, a.op === "new-folder");
          tell(a.root, a.on, { open: this.folder() });
          if (a.op === "new-file") openFloat(a.root, made, a.on, false);
        }
        closeOverlay(props()?.overlay);
      } catch (e) { this.busy = false; this.error = String(e?.message ?? e); cx.notify(); }
    });
  }

  render() {
    const t = theme(), a = this.a, name = nameOf(a.path) || nameOf(a.root.replace(/\\/g, "/"));
    const many = a.op === "delete" ? picked(a) : [];
    const title = a.op === "delete" ? (many.length > 1 ? `Delete ${many.length} items?` : `Delete "${name}"?`) : a.op === "rename" ? `Rename "${name}"` : a.op === "new-file" ? "New file" : "New folder";
    const where = [a.on, this.folder() || nameOf(a.root.replace(/\\/g, "/"))].filter(Boolean).join(" · ");
    const problem = this.problem();
    const button = (id, label, primary, danger, act) => h_flex().id(id).h(30).px(14).items_center().rounded(7).border_1()
      .border_color(primary ? (danger ? t.ansi1 : t.solid) : t.input).bg(primary ? (danger ? t.ansi1 : t.solid) : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .when(primary && (this.busy || problem !== null), (el) => el.opacity(0.5)).hover((s) => s.opacity(0.88)).on_click(act).child(label);
    const detail = a.op === "delete"
      ? (hereOnWindows(a.on) ? "It goes to the Recycle Bin." : "It goes to the trash there. On a machine with no trash command, it's deleted for good.")
        + (many.some((x) => x.dir) ? " Everything inside goes with it." : "")
      : null;
    return v_flex().id("files-ask").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
        else if (e.key === "enter" && a.op === "delete") this.submit(cx);
      })
      .child(div().font_semibold().text_size(14).child(title))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(a.op === "delete" ? (many.length > 1 ? many.map((x) => nameOf(x.path)).join(", ") : where) : `in ${where}` + (a.op === "rename" ? "" : " · a/b makes folders on the way")))
      .when(Boolean(this.input), (el) => el.child(Input.new(this.input).h(32).px(10).rounded(7).border_1()
        .border_color(problem ? t.ansi1 : t.input).bg(t.background).text_size(13)))
      .when(Boolean(detail), (el) => el.child(div().text_size(12).text_color(t.muted).child(detail)))
      .when(Boolean(this.error || problem), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).truncate().child(this.error || problem)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button("ask-no", "Cancel", false, false, () => closeOverlay(props()?.overlay)))
        .child(button("ask-yes", this.busy ? "…" : a.op === "delete" ? (hereOnWindows(a.on) ? "Move to Recycle Bin" : "Delete") : a.op === "rename" ? "Rename" : "Create",
          true, a.op === "delete", (_e, cx) => this.submit(cx))));
  }
}
