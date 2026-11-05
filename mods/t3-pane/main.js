// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "t3-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, agents, props, run, theme, home, layout } from "herdr";
import { modStatus, namer, programOf } from "./name.js";
import { ownStatus, subAgents, treeStatus } from "./tree.js";
import { tip, tipMark } from "./tip.js";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// Settled or snoozed (until it wakes) in the inbox isn't news, so its done dot goes, as in the tabs.
function settled(p) {
  const find = (n) => n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(find).find(Boolean);
  const labels = terminals().find((k) => k.address === p.terminal)?.labels;
  return find(layout())?.active === "inbox" && Boolean(labels?.settled || Number(labels?.snoozed) > Date.now());
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, label, action, key) {
    return tip(this.hot, t, id, label, div()
      .id(id)
      .size(26).flex_none().flex().items_center().justify_center()
      .rounded(6)
      // Its icon brightens by state: a hover style reaches text but not an svg, as in the inbox.
      .text_color(this.hot === id ? t.foreground : t.dim)
      .role("button").accessibility_label(label)
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hot = id;
        else if (this.hot === id) this.hot = null;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
        cx.notify();
      })
      .child(svg(icon).size(14)), { action: key });
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = namer()(p);
    const pic = icon(programOf(p), 14, t.muted);
    // Its agent with the sub-agents it started (tree.js).
    const all = terminals();
    const st = p.mod ? modStatus(p) : treeStatus(ownStatus(p.status, p.terminal, all), subAgents(agents(), all)(p.terminal));
    const pane = p.pane;
    // The rounded frame paints the background; rectangular child fills would cover its corners.
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(8)
      .gap(8)
      .items_center()
      .text_size(13)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .when(Boolean(p.terminal) && name !== p.terminal, (el) => el.child(div().flex_none().text_color(t.dim).child(p.terminal)))
      .child(div().min_w(0).truncate().text_size(13).font_medium().text_color(p.focused ? t.foreground : t.muted).child(name))
      .child(div().relative().flex_1().min_w(0).h_full().flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
        // Over the folder's end, so hovering moves nothing else, as in the agents list and the inbox.
        .when(this.hovered, el => el.child(h_flex().absolute().top(0).bottom(0).right(0).pl(8).flex_none().gap(4).items_center().bg(t.background)
          .child(this.button(t, `ph-r-${pane}`, "mods/t3-pane/split-right.svg", "Split right", () => run("pane.split", { direction: "right", pane }), "pane.split:right"))
          .child(this.button(t, `ph-d-${pane}`, "mods/t3-pane/split-down.svg", "Split down", () => run("pane.split", { direction: "down", pane }), "pane.split:down"))
          .child(this.button(t, `ph-z-${pane}`, `mods/t3-pane/${p.zoomed ? "unzoom" : "zoom"}.svg`, p.zoomed ? "Unzoom pane" : "Zoom pane", () => run("pane.zoom", { pane }), "pane.zoom"))
          .child(this.button(t, `ph-x-${pane}`, "mods/t3-pane/close.svg", "Close pane", () => { this.hot = null; run(`t3-tabs.close-pane:${pane}`); }, "pane.close")))))
      .when(st === "working", el => el.child(tipMark(this, t, `ph-mark-${pane}`, "Working", svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))))
      // The same marks as the agents list and tabs.
      .when(st === "blocked", el => el.child(tipMark(this, t, `ph-mark-${pane}`, "Needs you", div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().accessibility_label("Needs you").child("!"))))
      .when(st === "done" && !settled(p), el => el.child(tipMark(this, t, `ph-mark-${pane}`, "Done", div().size(7).flex_none().rounded_full().bg(t.done))));
  }
}
