// What the panel's views share: where the person is, whether a view shows, and a few drawn pieces.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, layout, exec, window } from "herdr";

export const MONO = "JetBrains Mono";
export const icon = (name) => name.includes("/") ? name : `mods/t3-panel/icons/${name}.svg`;
export const glyph = (name, size, color) => svg(icon(name)).size(size).flex_none().text_color(color);
export const spinner = (size, color) => svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(color).spin(900);

export function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

// The panel's stack child that shows now, or null while the panel is closed.
export function shownView() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return !panel || panel.hidden ? null : body?.active ?? null;
}

// Calls `go` soon after the view comes into sight or `key()` (where it looks) changes while it shows:
// a task can't start from render, so a light timer watches.
export function follow(cx, id, key, go) {
  let was = null;
  cx.timer.every(700, (cx) => {
    if (shownView() !== id) { was = null; return; }
    const now = key();
    if (now !== was) { was = now; go(cx); }
  });
}

// The focused terminal's folder and machine, as the Changes panel finds them. A mod pane keeps the last terminal's.
export function location(last = null) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal && !pane.cwd && last) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: on ?? null, space: space?.id ?? null };
}

// exec that never rejects: a machine away or a missing program reads as a failed command.
export const sh = (script, args = [], opts = {}) => exec("sh", ["-c", script, "sh", ...args], opts).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
export const run = (cmd, args, opts = {}) => exec(cmd, args, opts).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
export const lines = (s) => (s ?? "").split("\n").map((x) => x.replace(/\r$/, "")).filter(Boolean);
export const isWindows = () => window()?.platform === "windows";

// The default browser, here.
export function openUrl(url) {
  if (isWindows()) return void run("cmd", ["/c", "start", "", String(url).replace(/[&^|<>]/g, "^$&")]);
  void sh('(xdg-open "$1" || open "$1") >/dev/null 2>&1 &', [url]);
}

export function copyText(text) {
  // -Command takes no arguments of its own: the text goes in a single-quoted string, its quotes doubled.
  if (isWindows()) return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value '" + String(text).replace(/['‘’‚‛]/g, "$&$&") + "'"]);
  return sh('printf %s "$1" | (pbcopy 2>/dev/null || xclip -selection clipboard 2>/dev/null || wl-copy)', [text]);
}

export const bytes = (n) => {
  if (!Number.isFinite(n)) return "–";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
export const span = (secs) => {
  secs = Math.max(0, Math.round(secs));
  const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${secs}s`;
};
// A folder is `dir` or inside it, either slash.
export const within = (path, dir) => {
  if (!path || !dir) return false;
  const a = path.replace(/\\/g, "/").replace(/\/+$/, ""), b = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/");
};
export const baseName = (p) => (p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// A small button, as the Changes panel draws one: an icon, maybe words, maybe a tooltip.
export function button(id, label, t, onClick, { icon: name = null, primary = false, danger = false, enabled = true, invisible = false, tooltip = null } = {}) {
  const solid = primary && enabled;
  const fg = solid ? t.solid_foreground : !enabled ? t.dim : danger ? t.ansi1 : invisible ? t.muted : t.foreground;
  return h_flex().id(id).h(24).px(label === "" ? 5 : 8).gap(5).flex_none().items_center().justify_center().rounded(6).text_size(12).font_medium()
    .bg(solid ? t.solid : invisible ? "#00000000" : t.raised).border_1().border_color(solid ? t.solid : invisible ? "#00000000" : t.border)
    .text_color(fg)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(solid ? t.solid : t.hover).text_color(solid ? t.solid_foreground : danger ? t.ansi1 : t.foreground))
      .on_click((ev, cx) => { cx.stop_propagation(); onClick(ev, cx); }))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(Boolean(name), (e) => e.child(name === "spin" ? spinner(12, t.muted) : glyph(name, 13, fg)))
    .when(label !== "", (e) => e.child(label));
}

export const pill = (text, color, t) => div().h(17).px(6).flex_none().flex().items_center().rounded(9).text_size(10.5).font_medium()
  .bg(color + "1f").text_color(color).child(text);

// The card every panel view sits in (as Changes and GitHub draw theirs), with a 40px header.
export function card(t, id, title, sub, tools, body) {
  return v_flex().id(id).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .text_color(t.foreground).text_size(13)
    .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_semibold().truncate().child(title))
        .when(Boolean(sub), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(sub))))
      .child(h_flex().flex_none().gap(2).items_center().children(tools)))
    .child(body);
}

export function empty(t, title, body, actions = []) {
  return v_flex().flex_1().items_center().justify_center().gap(6).p(24)
    .child(div().text_size(13).font_semibold().child(title))
    .when(Boolean(body), (e) => e.child(div().text_size(12).text_color(t.muted).text_center().child(body)))
    .when(actions.length > 0, (e) => e.child(h_flex().gap(6).pt(6).children(actions)));
}

// A labelled bar: the share of `value` in `max`, tinted by how full it is.
export function meter(t, label, value, max, text) {
  const r = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const color = r > 0.9 ? t.ansi1 : r > 0.7 ? t.blocked : t.ansi2;
  return v_flex().gap(4)
    .child(h_flex().items_center().text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(label))
      .child(div().flex_none().pl(8).font_family(MONO).text_size(11.5).child(text)))
    .child(div().h(6).w_full().rounded(3).bg(t.raised).overflow_hidden()
      .child(div().h_full().w(`${(r * 100).toFixed(1)}%`).rounded(3).bg(color)));
}

// Every core terminal on one machine (null: this computer), sub-agents too: where it is now (its foreground
// program's folder), its space (the label Herdr put on it), whether it's an agent.
export function terminalsOn(on, all) {
  const machineOf = (address) => String(address).includes("/") ? String(address).slice(0, String(address).lastIndexOf("/")) : null;
  return all.filter((k) => k.state !== "exited" && machineOf(k.address) === (on ?? null)).map((k) => ({
    address: k.address, cwd: k.foreground?.cwd || k.cwd || null, space: k.labels?.["herdr.space"] ?? null,
    agent: Boolean(k.program?.agent), name: k.program?.name ?? k.foreground?.name ?? "terminal", status: k.status ?? "idle", parent: k.parent ?? null,
  }));
}
// A space by the id on its terminals' label (another machine's spaces carry a "<machine>/" prefix here).
export const spaceById = (sp, id) => id ? sp.find((s) => s.id === id || s.id.endsWith("/" + id)) ?? null : null;
