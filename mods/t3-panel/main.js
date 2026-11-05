// The right-hand panel of herdr-t3: a row of tabs over the panel's stack (Files, Changes, GitHub, and this mod's
// Worktrees, Ports and Machine), each copy one view by props: { view: "nav" | "worktrees" | "ports" | "machine" }.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, props, layout, run } from "herdr";
import { find, glyph, button } from "./common.js";
import { Worktrees } from "./worktrees.js";
import { Ports } from "./ports.js";
import { Machine } from "./machine.js";

// The stack's children, in the order the tabs show them.
export const VIEWS = [
  ["files", "Files", "mods/files/file.svg"],
  ["changes", "Changes", "mods/changes/changes.svg"],
  ["github", "GitHub", "mods/github/icons/github.svg"],
  ["worktrees", "Worktrees", "worktree"],
  ["ports", "Ports", "plug"],
  ["machine", "Machine", "cpu"],
];

export default class Panel extends View {
  init(_props, cx) {
    this.kind = props()?.view ?? "nav";
    this.hot = null;
    if (this.kind === "worktrees") this.part = new Worktrees(this, cx);
    else if (this.kind === "ports") this.part = new Ports(this, cx);
    else if (this.kind === "machine") this.part = new Machine(this, cx);
  }

  render(cx) {
    if (this.part) return this.part.render(cx);
    const t = theme(), body = find(layout(), "panel-body");
    const ids = new Set((body?.children ?? []).map((c) => c.id));
    // Every tab the same size, icon only: picking one moves nothing, so the next is where it was.
    // The name is in the tooltip and the view's own header.
    const tab = ([id, label, icon]) => {
      const on = body?.active === id, hot = this.hot === id;
      return div().id(`nav-${id}`).w(30).h(28).flex_none().relative().flex().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : hot ? t.hover : t.chrome)
        .tooltip(label).cursor_pointer()
        .on_hover((h, cx) => { this.hot = h ? id : this.hot === id ? null : this.hot; cx.notify(); })
        .on_click(() => run("layout.select", { stack: "panel-body", child: id }))
        .child(glyph(icon, 15, on || hot ? t.foreground : t.muted))
        .child(div().absolute().bottom(0).left(8).w(14).h(2).rounded(1).bg(on ? t.accent : "#00000000"));
    };
    return h_flex().size_full().min_w(0).px(2).gap(2).items_center().bg(t.chrome)
      .child(h_flex().id("nav-tabs").flex_1().min_w(0).gap(2).items_center().children(VIEWS.filter(([id]) => ids.has(id)).map(tab)))
      .child(button("nav-close", "", t, () => run("layout.hide", { id: "panel" }), { icon: "close", invisible: true, tooltip: "Close panel" }));
  }
}
