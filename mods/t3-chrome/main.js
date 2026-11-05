import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, updates, layout, nextCommand, shared } from "herdr";
import { tip } from "./tip.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar shows either Lists (Spaces and Agents) or the Inbox (t3-inbox): a stack in the layout.
const inboxShown = () => find(layout(), "sidebar-lists")?.active === "inbox";
const switchSidebar = () => run("layout.select", { stack: "sidebar-lists", child: inboxShown() ? "lists" : "inbox" });
// The next or previous agent. With the Inbox showing, as T3's thread traversal (resolveAdjacentThreadId): the rows it
// draws, in its order, from the one in view, stopping at either end; with none in view, the first or the last.
// Lists keep Herdr's agent.next, which wraps. The Inbox may be hidden, so this copy, always shown, takes the key.
// A row can be a mod pane's (`pane:<id>`), which has no agent to focus.
const step = (command) => {
  if (!inboxShown()) return run(command === "next" ? "agent.next" : "agent.prev");
  const { order = [], view = null } = shared("t3-inbox.rows") ?? {};
  const i = view === null ? -1 : order.indexOf(view);
  const to = view === null ? (command === "next" ? order[0] : order.at(-1)) : i < 0 ? null : order[command === "next" ? i + 1 : i - 1];
  if (to?.startsWith("pane:")) run("pane.focus", { pane: to.slice(5) });
  else if (to) run("agent.focus", { terminal: to });
};

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    // Only the brand bar's copy takes `t3-chrome.sidebar`, `.next` and `.prev`; the footer's would do them twice.
    if (props()?.footer) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "sidebar") switchSidebar();
        else if (command === "next" || command === "prev") step(command);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state, as in the inbox.
    const glow = (id) => (on, cx) => {
      if (on) this.hot = id;
      else if (this.hot === id) this.hot = null;
      cx.notify();
    };
    const lit = (id, color = t.dim) => (this.hot === id ? t.foreground : color);
    if (props()?.footer) {
      // As T3's footer: a row of 32px icon buttons, and at its end, once Herdr has downloaded an update, its restart.
      const ready = updates().app.ready;
      const button = (id, glyph, label, action, key) => tip(this.hot, t, id, label, div().id(id).size(32).flex_none().flex().items_center().justify_center().rounded(8)
        .text_color(lit(id)).hover(s => s.bg(t.hover)).on_hover(glow(id))
        .role("button").accessibility_label(label)
        // Each opens over its button, before the pointer can report leaving it.
        .on_click((_e, cx) => { this.hot = null; action(); cx.notify(); })
        .child(glyph), { action: key });
      return h_flex().size_full().bg(t.chrome).px(8).gap(2).items_center()
        .child(button("settings", svg("mods/t3-chrome/settings.svg").size(16), "Settings", () => run("app.settings"), "app.settings"))
        .child(button("add-machine", svg("mods/workspace-chrome/server.svg").size(16), "Add machine", () => run("mod.open", { name: "machine-add" })))
        .child(div().flex_1())
        .when(Boolean(ready), el => el.child(tip(this.hot, t, "app-update", `Update ${ready} downloaded. Click to restart`, div().id("app-update").h(24).px(10).flex_none().flex().items_center()
          .rounded_full().bg(t.accent + "26").text_size(12).font_medium().text_color(t.accent).hover(s => s.bg(t.accent + "40")).on_hover(glow("app-update"))
          .role("button").accessibility_label(`Restart into Herdr ${ready}`)
          .on_click(() => run("app.update")).child("Update"))));
    }
    // Room for the macOS window buttons (layout traffic_lights), a place to drag the window, and the
    // sidebar toggle at its right edge; while the sidebar is hidden, t3-tabs shows it after the buttons.
    const inbox = inboxShown();
    return h_flex().id("brand").size_full().bg(t.chrome).pr(10).gap(2).items_center().justify_end()
      .child(tip(this.hot, t, "sidebar-mode", inbox ? "Show lists" : "Show inbox", div().id("sidebar-mode").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(lit("sidebar-mode")).hover(s => s.bg(t.hover)).on_hover(glow("sidebar-mode"))
        .role("button").accessibility_label(inbox ? "Show lists" : "Show inbox")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(switchSidebar)
        .child(svg(`mods/workspace-chrome/${inbox ? "layers" : "circle-check"}.svg`).size(14)), { action: "t3-chrome.sidebar", below: true }))
      .child(tip(this.hot, t, "sidebar-toggle", "Hide sidebar", div().id("sidebar-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(lit("sidebar-toggle")).hover(s => s.bg(t.hover)).on_hover(glow("sidebar-toggle"))
        .role("button").accessibility_label("Hide sidebar")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        // It goes with the sidebar, before the pointer can report leaving it.
        .on_click(() => { this.hot = null; run("layout.toggle", { id: "sidebar" }); })
        .child(svg("mods/workspace-chrome/sidebar.svg").size(14)), { action: "layout.toggle:sidebar", below: true }));
  }
}
