// New: pick the space and open a terminal tab there, or start a new space, on a machine picked as T3 picks an environment,
// in a folder picked on that machine: its home first, typed or stepped into as a path.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, spaces, machines, panes, run, closeOverlay, props, window, keys, home, exec, pickFolder, shared, setShared } from "herdr";
import { projectMark } from "./project.js";
import { list, fold } from "./common/fsx.js";
import { resolve } from "./common/paths.js";
import { slashes, native, ps } from "./common/platform.js";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

// Where a space is now, as t3-spaces says it.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const ROW = 46;
const SHOWN = 6; // rows before the list scrolls; a virtual list has no height of its own, and the popup hugs its content
const STATE = { ready: "Connected", loading: "Loading…", unavailable: "Unavailable" };

// A machine's home as a whole path, so the folder a space gets means the same to its core. Its sh says,
// else its PowerShell.
async function homeOf(on) {
  if (!on) return slashes(home());
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
  if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  const p = await ps("$HOME", on).catch(() => null);
  return slashes(p?.stdout.trim() || "~");
}
const withSlash = (p) => (p.endsWith("/") ? p : p + "/");

export default class NewMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.filter = "";
    this.mode = "spaces"; // or "machines", choosing one for a new space, then "folder", choosing where on it
    this.where = null; // in "folder": { machine, home, base: the folder listed, dirs: its folders or null, err, part: what's typed after it }
    this.scroll = VirtualListScrollHandle.new();
    const field = (placeholder) => {
      const input = InputState.new({ placeholder });
      input.on("change", (_e, cx) => { this.filter = input.value(); this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
      input.on("submit", (_e, cx) => { this.choose(this.items()[this.at], cx); });
      return input;
    };
    this.folderInput = InputState.new({ placeholder: "Folder…" });
    this.folderInput.on("change", (_e, cx) => this.folderChanged(cx));
    this.folderInput.on("submit", (_e, cx) => { this.choose(this.items()[this.at], cx); });
    this.spaceInput = field("Search spaces…");
    this.machineInput = field("Search machines…");
    this.spaceInput.focus();
    // Opened by a New space button: straight to the machine, or to its folders when it named one.
    const start = shared("t3-new-menu.start");
    if (start) {
      setShared("t3-new-menu.start", null);
      if (Date.now() - start.at < 3000) {
        // `pick`: ask for the machine (an undefined machine comes back from shared state as null, this computer).
        // Show the machines, in case machines() hasn't come in this soon; with only this computer a moment later,
        // go on to its folders.
        if (start.pick || start.machine === undefined) {
          this.show("machines", cx);
          cx.timer.after(600, (cx) => {
            if (this.mode !== "machines" || this.filter) return;
            const rows = this.machineRows();
            if (rows.length === 1) this.openFolder(rows[0].machine, cx);
          });
        }
        else this.openFolder(start.machine, cx);
      }
    }
  }

  // The active space's machine first, as ⌘N would use it.
  machineRows() {
    const here = spaces().find(s => s.active)?.machine ?? null;
    const others = [...machines().map(k => k.name), ...spaces().map(s => s.machine)].filter(Boolean).sort();
    return [...new Set([here, null, ...others])].map(m => {
      const layout = m ? machines().find(k => k.name === m)?.layout ?? "unavailable" : "ready";
      return { key: `machine:${m ?? ""}`, machine: m, name: m ?? "This computer", sub: m ? STATE[layout] : "Local", off: layout !== "ready" };
    });
  }

  // The current space first, then its machine's, so a machine's spaces stay together.
  items() {
    const q = this.filter.toLowerCase();
    if (this.mode === "folder") return this.folderRows();
    if (this.mode === "machines") return this.machineRows().filter(m => m.name.toLowerCase().includes(q));
    const ps = panes(), here = spaces().find(s => s.active)?.machine ?? null;
    const rank = (s) => (s.active ? 0 : (s.machine ?? null) === here ? 1 : 2);
    return spaces().filter(s => `${s.name} ${s.machine ?? ""} ${place(s, ps)}`.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || (a.machine ?? "").localeCompare(b.machine ?? ""))
      .map(s => ({ key: `space:${s.id}`, space: s }));
  }

  // The folder step: "New space here" for the folder typed up to its last /, then its folders that start
  // with what follows, then those that hold it. Dot folders only once a dot is typed.
  folderRows() {
    const w = this.where;
    if (!w?.base) return [];
    const part = fold(w.part), hidden = part.startsWith(".");
    const dirs = (w.dirs ?? []).filter(n => hidden || !n.startsWith("."))
      .map(n => ({ n, f: fold(n) })).filter(d => d.f.includes(part))
      .sort((a, b) => Number(!a.f.startsWith(part)) - Number(!b.f.startsWith(part)) || a.f.localeCompare(b.f));
    return [{ key: "here", here: true, name: "New space here", sub: this.shown(w.base) },
      ...dirs.map(d => ({ key: `dir:${d.n}`, dir: d.n, name: d.n, sub: "" }))];
  }

  // A path as people read it: the machine's home as ~.
  shown(p) {
    const h = this.where?.home;
    return h && (p === h || p.startsWith(withSlash(h))) ? "~" + p.slice(h.length) : p;
  }

  choose(item, cx) {
    if (!item || item.off) return;
    if (this.mode === "machines") return this.openFolder(item.machine ?? null, cx);
    if (this.mode === "folder") return item.here ? this.create(this.where.base) : this.into(item.dir, cx);
    closeOverlay(props().overlay);
    if (item.space) run("tab.new", { space: item.space.id });
  }

  create(folder) {
    const on = this.where.machine;
    closeOverlay(props().overlay);
    run("space.new", { machine: on ?? "", folder: on ? folder : native(folder) });
  }

  // Into a folder: the input becomes it, so typing goes on from there.
  into(name, cx) {
    this.folderInput.set_value(withSlash(this.where.base) + name + "/");
    this.folderInput.focus();
    this.folderChanged(cx);
  }

  folderChanged(cx) {
    const w = this.where;
    if (!w?.home) return;
    const text = this.folderInput.value(), cut = text.lastIndexOf("/");
    const base = cut < 0 ? w.home : resolve(text.slice(0, cut + 1), { cwd: w.home, on: w.machine });
    w.part = text.slice(cut + 1);
    this.at = 0;
    this.scroll.scroll_to_item(0);
    if (base !== w.base) {
      Object.assign(w, { base, dirs: null, err: null });
      cx.spawn(async (cx) => {
        let dirs = [], err = null;
        try { dirs = (await list(base, w.machine, { limit: 2000, skipGit: true })).filter(e => e.dir).map(e => e.name); }
        catch (e) { err = String(e?.message ?? e).split("\n")[0] || "Can't read this folder"; }
        if (this.where !== w || w.base !== base) return;
        Object.assign(w, { dirs, err });
        cx.notify();
      });
    }
    cx.notify();
  }

  openFolder(machine, cx) {
    const w = { machine, home: null, base: null, dirs: null, err: null, part: "" };
    this.show("folder", cx);
    this.where = w;
    cx.spawn(async (cx) => {
      const h = await homeOf(machine);
      if (this.where !== w) return;
      w.home = h.length > 1 ? h.replace(/\/+$/, "") : h;
      if (/^[A-Za-z]:$/.test(w.home)) w.home += "/";
      this.folderInput.set_value(withSlash(w.home));
      this.folderChanged(cx);
    });
  }

  // The system's own folder picker, for this computer only.
  browse(cx) {
    cx.spawn(async () => {
      const f = await pickFolder({ prompt: "New space" });
      if (f) this.create(slashes(f));
    });
  }

  show(mode, cx) {
    this.mode = mode;
    this.where = null;
    this.at = 0;
    this.filter = "";
    const input = mode === "folder" ? this.folderInput : mode === "machines" ? this.machineInput : this.spaceInput;
    input.set_value("");
    input.focus();
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  // As T3's Add project: a machine to pick only when there is more than one.
  newSpace(cx) {
    const rows = this.machineRows();
    if (rows.length > 1) this.show("machines", cx);
    else this.openFolder(rows[0].machine, cx);
  }

  // A virtual list's rows can't hold handlers: clicks come by key to on_item_click, hover is style alone.
  row(item, i, ps) {
    const t = theme(), on = this.at === i, s = item.space, h = home();
    const short = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    // A home path means nothing on another machine, and its empty folder is its home.
    const sub = s ? (s.machine ? place(s, ps) || "~" : short(place(s, ps))) : item.sub;
    return h_flex().id(item.key).w_full().h(ROW).px(8).gap(8).rounded(6).items_center().flex_none()
      .role("button").accessibility_label(s ? s.name : item.name)
      .when(on, el => el.bg(t.selected))
      .when(!on && !item.off, el => el.hover(style => style.bg(t.foreground + "0a")))
      .when(Boolean(item.off), el => el.opacity(0.64))
      .child(h_flex().size(16).flex_none().items_center().justify_center()
        .child(s ? projectMark(s, 16, t, ps) : svg(`mods/workspace-chrome/${item.here ? "folder-plus" : item.dir !== undefined ? "folder" : item.machine ? "server" : "monitor"}.svg`).size(16).text_color(t.muted)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(s ? s.name : item.name))
        .child(h_flex().min_w(0).gap(4).items_center().text_size(11.5).text_color(t.dim)
          // As T3 marks a remote thread: a server icon, then the name.
          .when(Boolean(s?.machine), el => el
            .child(svg("mods/workspace-chrome/server.svg").size(12).flex_none().text_color(t.muted))
            .child(div().flex_none().text_color(t.muted).child(`${s.machine} ·`)))
          .when(Boolean(sub), el => el.child(div().min_w(0).truncate().child(sub)))))
      .when(Boolean(s) && i < 9, el => el.child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child(`⌘${i + 1}`)));
  }

  render() {
    const t = theme(), ps = panes(), items = this.items(), mode = this.mode, w = this.where;
    const key = (label) => div().flex_none().px(5).py(1).rounded(4).bg(t.foreground + "14").text_color(t.foreground).child(label);
    // Local change: each hint does what its key does when clicked (it was text only, so clicks did nothing).
    const input = mode === "folder" ? this.folderInput : mode === "machines" ? this.machineInput : this.spaceInput;
    const hint = (id, label, what, act) => h_flex().id(id).gap(6).px(4).py(1).ml(-4).rounded(6).items_center().flex_none()
      .role("button").accessibility_label(what).cursor_pointer().hover(s => s.bg(t.selected).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); })
      .child(key(label)).when(Boolean(what), el => el.child(what));
    const step = (by) => (cx) => {
      if (items.length) {
        this.at = (this.at + by + items.length) % items.length;
        this.scroll.scroll_to_item(this.at);
      }
      input.focus();
      cx.notify();
    };
    const into = (cx) => {
      const pick = items[this.at]?.dir !== undefined ? items[this.at] : items.find(r => r.dir !== undefined);
      if (pick) this.into(pick.dir, cx);
      else { input.focus(); cx.notify(); }
    };
    const navigate = h_flex().gap(6).items_center().flex_none()
      .child(h_flex().gap(2).items_center()
        .child(hint("hint-up", "↑", "", step(-1)).ml(0).px(0).accessibility_label("Previous"))
        .child(hint("hint-down", "↓", "", step(1)).ml(0).px(0).accessibility_label("Next")))
      .child("Navigate");
    const newKey = shortcut("space.new");
    const footButton = (id, label) => h_flex().id(id).gap(6).px(6).py(2).mr(-6).rounded(6).items_center().flex_none()
      .role("button").accessibility_label(label).hover(s => s.bg(t.selected));
    return v_flex().id("new-menu").size_full().min_h(0).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        if (e.key === "down" || e.key === "up") {
          if (!items.length) return;
          this.at = (this.at + (e.key === "down" ? 1 : items.length - 1)) % items.length;
          this.scroll.scroll_to_item(this.at);
        } else if (mode === "spaces" && /^[1-9]$/.test(e.key) && e.modifiers.platform) { cx.stop_propagation(); return this.choose(items[Number(e.key) - 1], cx); }
        else if (mode === "folder" && e.key === "tab") {
          const pick = items[this.at]?.dir !== undefined ? items[this.at] : items.find(r => r.dir !== undefined);
          cx.stop_propagation();
          if (pick) this.into(pick.dir, cx);
          return;
        }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(36).mt(6).flex_none().px(16).gap(8).items_center()
        .child(svg("mods/workspace-chrome/search.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(mode === "folder" ? this.folderInput : mode === "machines" ? this.machineInput : this.spaceInput).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(div().mt(8).px(16).py(6).flex_none().text_size(12).font_medium().text_color(t.muted)
        .child(mode === "folder" ? `Folder on ${w?.machine ?? "this computer"}` : mode === "machines" ? "Machines" : "Spaces"))
      .child(div().flex_none().mb(8).px(8)
        .when(items.length > 0, el => el.h(Math.min(items.length, SHOWN) * ROW).child(v_virtual_list("new-rows", items.length, ROW, (i) => items[i]?.key ?? String(i),
          (range) => items.slice(range.start, range.end).map((item, k) => this.row(item, range.start + k, ps)))
          .track_scroll(this.scroll).size_full()
          .on_item_click((id, cx) => this.choose(this.items().find(item => item.key === id), cx))))
        .when(items.length === 0, el => el.child(div().px(8).py(6).text_color(t.dim)
          .child(mode === "folder" ? "Finding its home…" : mode === "machines" ? "No matching machines." : "No matching spaces.")))
        .when(mode === "folder" && Boolean(w?.base) && (w.err || w.dirs === null), el => el.child(div().px(8).pt(4).text_size(12).text_color(t.dim)
          .child(w.err ?? "Reading…"))))
      .child(h_flex().flex_none().px(16).py(8).gap(12).items_center().justify_between().bg(t.foreground + "06").text_size(12).font_medium().text_color(t.muted)
        // The hints take the room left and give way; the buttons sit straight in this row. Wrapped in a row of their
        // own they measured about 0 wide and hung off the popup's right edge, showing only "Br".
        .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(12).items_center()
          .child(navigate)
          .child(hint("hint-enter", "Enter", mode === "folder" ? "Open" : mode === "machines" ? "Choose" : "New tab", (cx) => this.choose(items[this.at], cx)))
          .when(mode === "folder", el => el.child(hint("hint-tab", "Tab", "Into", into)))
          .child(hint("hint-esc", "Esc", "Close", () => closeOverlay(props().overlay))))
        .when(mode === "folder" && !w?.machine, el => el.child(footButton("new-browse", "Browse").mr(0).on_click((_e, cx) => this.browse(cx)).child("Browse…")))
        .when(mode === "folder", el => el.child(footButton("new-back", "Back").on_click((_e, cx) => this.show(this.machineRows().length > 1 ? "machines" : "spaces", cx))
          .child(this.machineRows().length > 1 ? "← Machines" : "← Spaces")))
        .when(mode === "machines", el => el.child(footButton("new-back", "Back to spaces").on_click((_e, cx) => this.show("spaces", cx)).child("← Spaces")))
        .when(mode === "spaces", el => el.child(footButton("space-new", "New space").on_click((_e, cx) => this.newSpace(cx))
          .child(svg("mods/workspace-chrome/folder-plus.svg").size(14).text_color(t.muted))
          .child("New space")
          .when(Boolean(newKey), row => row.child(key(newKey))))));
  }
}
