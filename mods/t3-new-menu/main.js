// New: pick the space and open a terminal tab there, or start a new space, on a machine picked as T3 picks an environment.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, spaces, machines, panes, run, closeOverlay, props, window, keys, home } from "herdr";
import { projectMark } from "./project.js";

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

export default class NewMenu extends View {
  init() {
    this.at = 0;
    this.filter = "";
    this.picking = false; // choosing the machine for a new space
    this.scroll = VirtualListScrollHandle.new();
    const field = (placeholder) => {
      const input = InputState.new({ placeholder });
      input.on("change", (_e, cx) => { this.filter = input.value(); this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
      input.on("submit", () => { this.choose(this.items()[this.at]); });
      return input;
    };
    this.spaceInput = field("Search spaces…");
    this.machineInput = field("Search machines…");
    this.spaceInput.focus();
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
    if (this.picking) return this.machineRows().filter(m => m.name.toLowerCase().includes(q));
    const ps = panes(), here = spaces().find(s => s.active)?.machine ?? null;
    const rank = (s) => (s.active ? 0 : (s.machine ?? null) === here ? 1 : 2);
    return spaces().filter(s => `${s.name} ${s.machine ?? ""} ${place(s, ps)}`.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || (a.machine ?? "").localeCompare(b.machine ?? ""))
      .map(s => ({ key: `space:${s.id}`, space: s }));
  }

  choose(item) {
    if (!item || item.off) return;
    closeOverlay(props().overlay);
    if (item.space) run("tab.new", { space: item.space.id });
    else run("space.new", { machine: item.machine ?? "" });
  }

  showMachines(on, cx) {
    this.picking = on;
    this.at = 0;
    this.filter = "";
    const input = on ? this.machineInput : this.spaceInput;
    input.set_value("");
    input.focus();
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  // As T3's Add project: a machine to pick only when there is more than one.
  newSpace(cx) {
    const rows = this.machineRows();
    if (rows.length > 1) this.showMachines(true, cx);
    else this.choose(rows[0]);
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
        .child(s ? projectMark(s, 16, t, ps) : svg(`mods/workspace-chrome/${item.machine ? "server" : "monitor"}.svg`).size(16).text_color(t.muted)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(s ? s.name : item.name))
        .child(h_flex().min_w(0).gap(4).items_center().text_size(11.5).text_color(t.dim)
          // As T3 marks a remote thread: a server icon, then the name.
          .when(Boolean(s?.machine), el => el
            .child(svg("mods/workspace-chrome/server.svg").size(12).flex_none().text_color(t.muted))
            .child(div().flex_none().text_color(t.muted).child(`${s.machine} ·`)))
          .child(div().min_w(0).truncate().child(sub))))
      .when(Boolean(s) && i < 9, el => el.child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child(`⌘${i + 1}`)));
  }

  render() {
    const t = theme(), ps = panes(), items = this.items();
    const key = (label) => div().flex_none().px(5).py(1).rounded(4).bg(t.foreground + "14").text_color(t.foreground).child(label);
    const hint = (label, what) => h_flex().gap(6).items_center().child(key(label)).child(what);
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
        } else if (!this.picking && /^[1-9]$/.test(e.key) && e.modifiers.platform) { cx.stop_propagation(); return this.choose(items[Number(e.key) - 1]); }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(36).mt(6).flex_none().px(16).gap(8).items_center()
        .child(svg("mods/workspace-chrome/search.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.picking ? this.machineInput : this.spaceInput).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(div().mt(8).px(16).py(6).flex_none().text_size(12).font_medium().text_color(t.muted).child(this.picking ? "Machines" : "Spaces"))
      .child(div().flex_none().mb(8).px(8)
        .when(items.length > 0, el => el.h(Math.min(items.length, SHOWN) * ROW).child(v_virtual_list("new-rows", items.length, ROW, (i) => items[i]?.key ?? String(i),
          (range) => items.slice(range.start, range.end).map((item, k) => this.row(item, range.start + k, ps)))
          .track_scroll(this.scroll).size_full()
          .on_item_click((id) => this.choose(this.items().find(item => item.key === id)))))
        .when(items.length === 0, el => el.child(div().px(8).py(6).text_color(t.dim).child(this.picking ? "No matching machines." : "No matching spaces."))))
      .child(h_flex().flex_none().px(16).py(8).gap(12).items_center().justify_between().bg(t.foreground + "06").text_size(12).font_medium().text_color(t.muted)
        .child(h_flex().gap(12).items_center()
          .child(hint("↑ ↓", "Navigate"))
          .child(hint("Enter", this.picking ? "New space" : "New tab"))
          .child(hint("Esc", "Close")))
        .when(this.picking, el => el.child(footButton("new-back", "Back to spaces").on_click((_e, cx) => this.showMachines(false, cx)).child("← Spaces")))
        .when(!this.picking, el => el.child(footButton("space-new", "New space").on_click((_e, cx) => this.newSpace(cx))
          .child(svg("mods/workspace-chrome/folder-plus.svg").size(14).text_color(t.muted))
          .child("New space")
          .when(Boolean(newKey), row => row.child(key(newKey))))));
  }
}
