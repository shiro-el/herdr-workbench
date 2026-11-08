// Right-click menus for panes and tabs, after VS Code's: split, zoom, move to a new space or tab, close.
// A popup with props { tab: "pane" | "tab" | "move", target }: the terminal's own right-click (the layout's
// terminal_menu), a pane header's (t3-pane), a tab's (t3-tabs), and the list of places "Move to..." opens.
// ↑/↓ move, Enter runs, Esc closes. Moving and closing are t3-tabs' commands: a popup is gone once it's chosen from,
// and what it started goes with it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, terminals, spaces, panes } from "herdr";

const ROW = 30, SEP = 9, PAD = 10, PICK_WIDTH = 300, PICK_MAX = 400;
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;
const pane = (name) => `mods/t3-pane/${name}.svg`;

const hex = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
// A place nobody has: Herdr makes a space or tab for an id it doesn't know.
const fresh = (kind, machine) => `${machine ? `${machine}/` : ""}${kind}${hex()}`;

const spaceOf = (p) => spaces().find((s) => s.tabs.some((c) => c.id === p.tab));
const countIn = (ids) => panes().filter((q) => ids.includes(q.tab)).length;
const move = (terminal, space, tab) => run(`t3-tabs.move:${terminal} ${space} ${tab}`);

// Every other tab on this pane's machine: a terminal can't leave its machine.
function places(p) {
  const from = spaceOf(p);
  if (!from) return [];
  return spaces().filter((s) => (s.machine ?? null) === (from.machine ?? null)).flatMap((s) =>
    s.tabs.filter((c) => c.id !== p.tab).map((c) => ({ space: s.id, tab: c.id, label: s.tabs.length > 1 ? `${s.name} · ${c.name}` : s.name })));
}

// Every row is always there, greyed when it can't apply, so the popup's height (mod.json's, and t3-pane's) is one number.
function paneItems(tg) {
  const p = panes().find((q) => q.pane === tg.pane);
  const all = terminals(), term = p?.terminal ? all.find((k) => k.address === p.terminal) : null;
  const parent = term?.parent && all.find((k) => k.address === term.parent);
  const toProgram = term?.labels?.["herdr.right-click"] === "program";
  const from = p && spaceOf(p);
  const there = term ? places(p) : [];
  const machine = from?.machine ?? null;
  return [
    { label: "Split right", icon: pane("split-right"), off: !p, act: () => run("pane.split", { direction: "right", pane: p.pane }) },
    { label: "Split down", icon: pane("split-down"), off: !p, act: () => run("pane.split", { direction: "down", pane: p.pane }) },
    { label: p?.zoomed ? "Unzoom" : "Zoom", icon: pane(p?.zoomed ? "unzoom" : "zoom"), off: !p, act: () => run("pane.zoom", { pane: p.pane }) },
    "-",
    // A space's or tab's only pane is already alone there.
    { label: "Move to new space", icon: chrome("folder-plus"), off: !term || !from || countIn(from.tabs.map((c) => c.id)) < 2,
      act: () => move(term.address, fresh("sp", machine), fresh("tb", machine)) },
    { label: "Move to new tab", icon: chrome("plus"), off: !term || !from || countIn([p.tab]) < 2,
      act: () => move(term.address, from.id, fresh("tb", machine)) },
    { label: "Move to...", icon: chrome("layers"), off: there.length === 0,
      act: () => openOverlay({ mod: "t3-menu", kind: "popup", width: PICK_WIDTH, height: Math.min(PICK_MAX, PAD + there.length * ROW), props: { tab: "move", target: { pane: p.pane } } }) },
    { label: parent ? `Send back to ${parent.name || parent.address}` : "Send back to parent", icon: chrome("terminal"), off: !parent,
      act: () => run("terminal.park", { terminal: term.address }) },
    "-",
    { label: toProgram ? "Use Herdr right-click menu" : "Send right-clicks to pane", icon: chrome("terminal"), off: !term,
      act: () => run("terminal.right_click", { terminal: term.address, to: toProgram ? "menu" : "program" }) },
    "-",
    { label: "Close pane", icon: chrome("x"), off: !p, act: () => run(`t3-tabs.close-pane:${p.pane}`) },
    { label: "Close other panes", icon: chrome("x"), off: !p || countIn([p.tab]) < 2, act: () => run(`t3-tabs.close-others:${p.pane}`) },
  ];
}

function moveItems(tg) {
  const p = panes().find((q) => q.pane === tg.pane);
  if (!p?.terminal) return [];
  return places(p).map((d) => ({ label: d.label, icon: chrome("layers"), act: () => move(p.terminal, d.space, d.tab) }));
}

const tabItems = (tg) => [
  { label: "Rename", icon: chrome("square-pen"), act: () => run("tab.rename", { id: tg.id }) },
  { label: "New tab", icon: chrome("plus"), act: () => run("tab.new", { space: tg.space }) },
  "-",
  { label: "Close", icon: chrome("x"), act: () => run(`t3-tabs.close-tab:${tg.id}`) },
];

function items(p) {
  const tg = p?.target ?? {};
  return p?.tab === "tab" ? tabItems(tg) : p?.tab === "move" ? moveItems(tg) : paneItems(tg);
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(it) {
    if (!it || it.off) return;
    closeOverlay(props().overlay);
    it.act();
  }

  render() {
    const t = theme(), list = items(props());
    const live = list.filter((it) => it !== "-" && !it.off);
    // A popup is as tall as what it holds, and a scroll area holds nothing until it's given a height: only a long list scrolls.
    const long = list.length * ROW > PICK_MAX - PAD;
    const body = list.map((it, i) => it === "-"
      ? div().id(`menu-sep-${i}`).mx(7).my(4).h(1).flex_none().bg(t.border)
      : h_flex().id(`menu-${i}`).h(ROW).flex_none().px(8).gap(9).rounded(7).items_center()
        .text_color(it.off ? t.dim : t.foreground)
        .when(!it.off && live[this.at] === it, (el) => el.bg(t.selected))
        .when(!it.off, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.choose(it))
        .child(svg(it.icon).size(14).flex_none().text_color(it.off ? t.dim : t.muted))
        .child(div().flex_1().min_w(0).truncate().child(it.label)));
    return v_flex().id("t3-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % live.length;
        else if (e.key === "up") this.at = (this.at <= 0 ? live.length : this.at) - 1;
        else if (e.key === "enter") return this.choose(live[this.at]);
        else if (e.key === "escape") return closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(long, (el) => el.child(v_flex().id("menu-scroll").h(PICK_MAX - PAD).overflow_y_scrollbar().children(body)))
      .when(!long, (el) => el.children(body));
  }
}
