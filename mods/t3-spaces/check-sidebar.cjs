const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(kind = "div", source) {
  const node = { kind, source, items: [], handlers: {}, style: {}, hoverStyle: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child" || (key === "trigger" && kind === "hovercard")) node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "on_mouse_down" || key === "on_mouse_up") node.handlers[`${key}:${args[0]}`] = args[1];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else if (key === "id") node.key = args[0];
      else if (key === "hover") { const hovered = element(); args[0](hovered); node.hoverStyle = hovered.style; }
      else node.style[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}

// Mods run in their own vm context: a plain copy compares with this one's objects.
const plain = v => JSON.parse(JSON.stringify(v));
// A row's laid-out children, without the absolutely placed tree lines.
const inFlow = row => row.items.filter(n => !("absolute" in n.style));

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const child of node.items) { const found = find(child, id); if (found) return found; }
  return null;
}
function strings(node) {
  if (typeof node === "string") return [node];
  return node && typeof node === "object" ? node.items.flatMap(strings) : [];
}
function walk(node) {
  return node && typeof node === "object" ? [node, ...node.items.flatMap(walk)] : [];
}
function fire(node, event, ...args) {
  assert.ok(node, `missing event target: ${event}`);
  assert.equal(typeof node.handlers[event], "function", event);
  return node.handlers[event](...args);
}

const modRoot = path.dirname(__dirname);
const cx = { notify() {}, stop_propagation() {}, spawn() {}, timers: [], timer: { every() {}, after(ms, fn) { const t = { ms, fn, cancel() { t.gone = true; } }; cx.timers.push(t); return t; } }, focus_handle: () => { let gone = false; return { focus() { assert.ok(!gone, "a released FocusHandle throws when used"); }, is_focused: () => false, release() { gone = true; return true; } }; } };
function fixture(width) {
  const program = { key: "pi", name: "Pi", agent: true, tint: true, icon: "icons/pi.svg" };
  const tabs = ["local task", "second task", "remote task"].map((name, i) => ({ id: `b${i}`, name, named: true }));
  const spaces = tabs.map((tab, i) => ({ id: `s${i}`, name: `project ${i}`, active: i === 0, folder: `/work/p${i}`, machine: i === 2 ? "vps" : null, status: "working", tabs: [tab] }));
  const agents = [0, 2].map((i) => ({ address: i === 2 ? "vps/t2" : "t0", pane: `p${i}`, space: `s${i}`, space_name: spaces[i].name, tab: `b${i}`, title: tabs[i].name, seq: i, program, focused: i === 0, status: i === 0 ? "working" : "blocked" }));
  const terminals = [...agents.map(a => ({ ...a, state: "live" })),
    { address: "child", parent: "t0", name: "child task", state: "live", status: "error", program },
    { address: "grandchild", parent: "child", name: "grandchild task", state: "live", status: "working", program }];
  const panes = agents.map(a => ({ ...a, terminal: a.address, cwd: `/work/${a.space}` }));
  const slots = { sidebar: { id: "sidebar", size: { px: width } }, spaces: { id: "spaces", size: { px: 90 } } };
  const state = { "agents.sort": "grouped" };
  const calls = [], overlays = [], stores = new Map(), scopes = new Map(), labelled = [], shown = { agent: "child" }, commands = [], closed = [];
  // What a test may change about the window and the app: the window, the layout's root fields, the update state.
  const ui = { window: { platform: "macos" }, root: {}, updates: { app: {} } };
  let hcAnswer = () => ({ code: 0 });
  const theme = new Proxy({ selected: "#2c2c2f", hover: "#202024", working: "#6b93ff", blocked: "#f0a33a", done: "#ececf0", muted: "#a9a9b4", foreground: "#f4f4f6", dim: "#77777f", ansi3: "#c8a84b", ansi4: "#5f8fe0", ansi11: "#e8cf7a", ansi12: "#8fb4f2" }, { get: (t, k) => t[k] ?? "#a9a9b4" });
  const env = {
    View: class {}, div: () => element(), h_flex: () => element("h"), v_flex: () => element("v"),
    Button: { new: id => element("button").id(id) },
    Popover: { new: id => element("popover").id(id) }, HoverCard: { new: id => element("hovercard").id(id) }, Popup: { new: id => element("popup").id(id) }, Input: { new: () => element("input") },
    InputState: { new: () => ({ on() {}, value: () => "", set_value() {}, focus() {} }) },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) }, v_virtual_list: (id, n, size, key, draw) => { const list = element("list").id(id); for (const row of draw({ start: 0, end: n }, cx)) list.child(row); return list; },
    svg: source => element("svg", source), image: source => element("image", source),
    spaces: () => spaces, agents: () => agents, terminals: () => terminals, panes: () => panes,
    machines: () => [{ name: null, layout: "ready" }, { name: "vps", layout: "ready" }], focused: () => shown,
    exec: async () => ({ code: 1, stdout: "" }), readTextFile: async () => null,
    window: () => ui.window, props: () => ({}), theme: () => theme,
    settings: () => ({ zoom: 1 }), home: () => "/home/test",
    layout: () => ({ ...ui.root, children: Object.values(slots) }), shared: key => state[key],
    setShared: (key, value) => { state[key] = value; }, setAgentOrder() {},
    hc: (args) => { labelled.push([...args]); return Promise.resolve(hcAnswer(args)); }, notify() {},
    run: (name, args) => {
      calls.push([name, JSON.parse(JSON.stringify(args ?? {}))]);
      if (name === "layout.resize" && slots[args.id]) slots[args.id].size = { px: args.px };
    },
    openOverlay: spec => overlays.push(spec), closeOverlay: id => closed.push(id), updates: () => ui.updates,
    nextCommand: () => commands.length ? Promise.resolve(commands.shift()) : new Promise(() => {}),
    keys: () => [{ section: "global", keys: "cmd-t", action: "tab.new" }],
  };
  function load(name, props = {}) {
    const storage = stores.get(name) ?? new Map();
    stores.set(name, storage);
    const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    const read = file => fs.readFileSync(path.join(modRoot, name, file), "utf8");
    // name.js, tree.js, project.js, tip.js and details.js, the shared naming, status, space-mark, hover-label and details rules, are inlined as the mod's own modules are.
    const shared = ["name.js", "tree.js", "project.js", "tip.js", "details.js"].filter(f => fs.existsSync(path.join(modRoot, name, f))).map(f => read(f) + "\n").join("");
    const source = (shared + read("main.js"))
      .replace(/^import .*;\r?\n/gm, "").replace(/export (function|const) /g, "$1 ")
      .replace("export default class", "globalThis.Mod = class");
    const context = vm.createContext({ ...env, localStorage, props: () => props, fs: fs.promises, appHome: () => path.dirname(modRoot) });
    vm.runInContext(source, context, { filename: name });
    scopes.set(name, context);
    const mod = new context.Mod();
    mod.init?.(props, cx);
    return mod;
  }
  return { ...env, load, slots, state, calls, overlays, stores, scopes, labelled, shown, commands, closed, ui, answerHc: fn => { hcAnswer = fn; } };
}

for (const width of [208, 240, 256, 320, 480]) {
  const f = fixture(width);
  const sp = f.load("t3-spaces"), ag = f.load("t3-agents");
  const st = sp.render(cx);
  let at = ag.render(cx);
  assert.ok(find(at, "fold-t0") && !find(at, "sub-grandchild"), "sub-agents start folded");
  // The child is in error: folded, it still shows, one step in, hung from the parent.
  assert.equal(find(at, "sub-child").style.pl, 28, "a stuck sub-agent shows under its folded parent");
  f.terminals().find(k => k.address === "grandchild").status = "blocked";
  const stuck = ag.render(cx);
  assert.deepEqual([find(stuck, "sub-child").style.pl, find(stuck, "sub-grandchild").style.pl], [28, 28], "every stuck one hangs straight from the parent");
  f.terminals().find(k => k.address === "grandchild").status = "working";
  ag.toggleFold("t0", cx);
  Object.assign(ag.folded, { gone: false, "vps/gone": false, "far/t1": false, "sp-gone": true });
  ag.render(cx);
  assert.deepEqual(Object.keys(ag.folded).sort(), ["far/t1", "sp-gone", "t0"], "an ended agent's fold goes; a quiet machine's and group headers stay");
  at = ag.render(cx);
  const space = find(st, "space-s0"), agent = find(at, "ag-t0");
  assert.ok(strings(space).includes("project 0"), `space identity at ${width}`);
  assert.ok(strings(agent).includes("local task"), `agent identity at ${width}`);
  assert.equal(space.style.bg, "#2c2c2f");
  assert.equal(agent.style.bg, "#2c2c2f");
  const child = find(at, "sub-child"), grandchild = find(at, "sub-grandchild");
  assert.ok(child.style.pl > agent.style.px, "child is indented from its parent");
  assert.ok(grandchild.style.pl > child.style.pl, "each descendant level is indented");
  assert.ok(strings(child).includes("child task"), "sub-agent keeps its name");
  assert.equal(child.style.bg, f.theme().selected, "parent and peeked child share the selection color");
  for (const row of [space, agent, child]) assert.equal(row.hoverStyle.bg, undefined, "hover preserves a selected row");
  for (const row of [find(st, "space-s1"), find(at, "ag-vps/t2"), grandchild]) assert.equal(row.hoverStyle.bg, f.theme().hover);
  assert.equal(child.style.pl, 28, "first child sits one 20px step in, its turn hung from the parent icon");
  assert.equal(grandchild.style.pl - child.style.pl, 20);
  assert.equal(child.style.text_size, 13);
  for (const row of [agent, child, grandchild]) {
    assert.equal(inFlow(row)[0].style.size, 18, "icons share a fixed column");
    assert.equal(row.style.gap, 8);
  }
  const lines = row => row.items.filter(n => "absolute" in n.style).map(n => [n.style.left, "border_b" in n.style ? "elbow" : "line"]);
  assert.deepEqual(lines(child), [[16.25, "elbow"]], "a last child turns in from under its parent's icon");
  assert.deepEqual(lines(grandchild), [[36.25, "elbow"]], "no line continues past a last child");
  f.terminals().push({ address: "child2", parent: "t0", name: "second child", state: "live", status: "idle", program: f.agents()[0].program });
  const branched = ag.render(cx);
  assert.deepEqual(lines(find(branched, "sub-child")), [[16.25, "line"], [16.25, "elbow"]], "a middle child keeps the line going");
  assert.deepEqual(lines(find(branched, "sub-grandchild")), [[16.25, "line"], [36.25, "elbow"]], "descendants carry their ancestors' lines");
  assert.deepEqual(lines(find(branched, "sub-child2")), [[16.25, "elbow"]]);
  const elbow = find(child, "sub-child").items.find(n => "border_b" in n.style).style;
  assert.deepEqual([elbow.w, elbow.rounded_bl], [9.75, 6], "upstream-size turn: ends 4px before the icon, 6px radius");
  assert.equal(elbow.left + 1.5 / 2, agent.style.px + inFlow(agent)[0].style.size / 2, "the line runs down the parent icon's center");
  assert.equal(elbow.left + elbow.w + 4, child.style.pl + (18 - 14) / 2, "the turn stops 4px before the child icon");
  f.terminals().pop();
  assert.equal(space.items[0].style.gap, 8);
  assert.equal(space.items[0].items[0].style.size, 18);
  assert.equal(find(st, "spaces-heading").style.pr, find(at, "agents-heading").style.pr, "header actions share a right edge");
  assert.equal(find(at, "controls-t0").style.gap, 4);
  for (const id of ["status-t0", "status-vps/t2", "sub-status-child", "sub-status-grandchild"]) assert.equal(find(at, id).style.size, 20);
  assert.equal(find(agent, "pin-t0"), null, "hidden pin has no click target");
  assert.deepEqual(find(at, "controls-t0").items.map(n => n.key), ["tip-fold-t0", "when-t0", "tip-status-t0-mark"], "a parent shows its fold arrow and time before the status, as the shipped list");
  assert.equal(find(at, "fold-t0").items[0].source, "mods/workspace-chrome/chevron-down.svg");
  assert.deepEqual(strings(find(at, "when-t0")), ["<1m"], "time in its state, as the shipped list");
  fire(agent, "on_hover", true, cx);
  const hoveredTree = ag.render(cx);
  assert.notEqual(find(hoveredTree, "agent-fold-t0").items[0]?.source, "mods/workspace-chrome/chevron-down.svg", "hover leaves the icon alone");
  assert.equal(find(hoveredTree, "agent-fold-t0").style.size, 18);
  assert.equal(find(hoveredTree, "pin-t0").style.size, 20, "pin is as wide as the time's slot");
  assert.equal(find(hoveredTree, "pin-t0").style.border, undefined, "pin is borderless like fold");
  fire(find(hoveredTree, "pin-t0"), "on_hover", true, cx);
  assert.equal(find(ag.render(cx), "pin-t0").items[0].style.text_color, f.theme().foreground, "hovered, the pin brightens");
  fire(find(hoveredTree, "pin-t0"), "on_hover", false, cx);
  assert.deepEqual(find(hoveredTree, "controls-t0").items.map(n => n.key), ["tip-fold-t0", "tip-pin-t0", "tip-status-t0-mark"], "pin takes the time's slot, the status stays, as the shipped list");
  assert.equal(find(at, "when-t0").style.min_w, 20, "the time's slot is the pin's width, so hovering moves nothing");
  fire(find(hoveredTree, "ag-t0"), "on_hover", false, cx);
  assert.ok(find(ag.render(cx), "when-t0") && !find(ag.render(cx), "pin-t0"), "leaving restores the time");
  assert.equal(find(at, "agent-menu-t0"), null, "no extra context menu");
  assert.equal(space.items[0].style.justify_center, undefined, "space content stays left aligned");
  assert.equal(agent.style.justify_center, undefined, "agent content stays left aligned");
  assert.equal(find(st, "sidebar-collapse"), null, "no inline sidebar toggle");
  assert.equal(find(at, "collapse"), null, "no sidebar expand control");
  assert.ok(find(at, "sp-s0"), "space group remains visible");
  fire(find(at, "agent-fold-t0"), "on_click", {}, cx);
  at = ag.render(cx);
  assert.equal(find(at, "sub-grandchild"), null, "descendants fold in place");
  assert.equal(find(at, "fold-t0").style.min_w, 20);
  assert.equal(find(at, "fold-t0").style.h, 20);
  assert.ok(strings(find(at, "fold-t0")).includes("2"), "folded badge counts descendants");
  assert.equal(find(at, "fold-t0").items[0].source, "mods/workspace-chrome/chevron-right.svg", "folded, the arrow points right");
  assert.equal(find(at, "fold-t0").items[1], "2", "and the count follows");
  assert.equal(find(at, "fold-t0").style.text_color, f.theme().dim, "count is dim");
  // Inside a hovered row a button's own fill doesn't show: its arrow and count brighten together instead.
  fire(find(at, "fold-t0"), "on_hover", true, cx);
  const lit = find(ag.render(cx), "fold-t0");
  assert.deepEqual([lit.style.text_color, lit.items[0].style.text_color], [f.theme().foreground, f.theme().foreground], "hovered, the arrow and the count brighten together");
  fire(lit, "on_hover", false, cx);
  assert.equal(find(ag.render(cx), "fold-t0").items[0].style.text_color, f.theme().dim);
  assert.equal(find(at, "status-t0").style.accessibility_label, "Needs you (sub-agent)", "folded status carries a more urgent hidden child");
  f.agents()[0].status = "blocked";
  assert.equal(find(ag.render(cx), "status-t0").style.accessibility_label, "Needs you", "a row as urgent as its children shows its own status");
  f.agents()[0].status = "idle";
  assert.equal(find(ag.render(cx), "status-t0").style.accessibility_label, "Needs you (sub-agent)");
  f.agents()[0].status = "working";
  const t0 = f.terminals().find(k => k.address === "t0");
  t0.labels = { "pi.session": "mine" };
  assert.ok(strings(find(ag.render(cx), "ag-t0")).includes("mine"), "a lone agent reads as its session, as in the inbox");
  f.agents().push({ ...f.agents()[0], address: "t1", pane: "p1", seq: 1, focused: false });
  f.terminals().push({ address: "t1", state: "live", labels: { "pi.session": "theirs" } });
  const shared = ag.render(cx);
  assert.ok(strings(find(shared, "ag-t0")).includes("mine") && strings(find(shared, "ag-t1")).includes("theirs"), "agents sharing a tab read as their own sessions");
  f.terminals().at(-1).labels = {};
  assert.ok(strings(find(ag.render(cx), "ag-t1")).includes("local task"), "without a session label it falls back to the tab");
  f.agents().pop(); f.terminals().pop(); delete t0.labels;
  assert.equal(f.slots.sidebar.size.px, width, "folding preserves sidebar width");
  fire(find(at, "fold-t0"), "on_click", {}, cx);
  at = ag.render(cx);
  assert.ok(find(at, "sub-child") && !strings(find(at, "fold-t0")).includes("2"), "the fold unfolds and drops its count");
  fire(find(at, "sub-child"), "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["terminal.peek", { terminal: "child" }]);
  fire(agent, "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["agent.focus", { terminal: "t0" }]);
  assert.equal(f.state["agents.pins"], undefined, "ordinary row click does not pin");
  fire(space, "on_mouse_down:left", {}, cx);
  fire(space, "on_mouse_up:left", {}, cx);
  assert.deepEqual(f.calls.pop(), ["space.select", { id: "s0" }]);
  fire(find(st, "space-s2"), "on_mouse_down:right", {}, cx);
  assert.deepEqual(JSON.parse(JSON.stringify(f.overlays.pop().props.target)), { id: "s2" });
  fire(find(at, "ag-sort"), "on_click", {}, cx);
  assert.equal(f.overlays.pop().mod, "t3-agents");
  fire(find(at, "agent-fold-t0"), "on_click", {}, cx);
  assert.equal(find(ag.render(cx), "sub-grandchild"), null);
  fire(find(ag.render(cx), "agent-fold-t0"), "on_click", {}, cx);
  assert.ok(find(ag.render(cx), "sub-child"));
  const beforePin = f.calls.length;
  let stopped = false;
  fire(find(ag.render(cx), "ag-t0"), "on_hover", true, cx);
  fire(find(ag.render(cx), "pin-t0"), "on_click", {}, { ...cx, stop_propagation() { stopped = true; } });
  assert.ok(stopped, "pin button stops propagation to the row");
  assert.ok(f.state["agents.pins"].includes("t0"));
  assert.equal(find(ag.render(cx), "pin-t0"), null, "pinning does not leave a stale hover after reordering");
  fire(find(ag.render(cx), "ag-t0"), "on_hover", true, cx);
  assert.equal(find(ag.render(cx), "pin-t0").items[0].source, "mods/workspace-chrome/pin-off.svg", "pinned rows offer unpin");
  fire(find(ag.render(cx), "ag-t0"), "on_hover", false, cx);
  assert.equal(find(ag.render(cx), "pin-t0"), null, "pinned rows also hide their pin outside hover");
  fire(find(ag.render(cx), "ag-t0"), "on_hover", true, cx);
  fire(find(ag.render(cx), "pin-t0"), "on_click", {}, cx);
  assert.equal(f.state["agents.pins"].includes("t0"), false, "unpin still persists");
  assert.equal(f.calls.length, beforePin, "pin and unpin do not focus a pane");
  fire(find(ag.render(cx), "ag-vps/t2"), "on_hover", true, cx);
  fire(find(ag.render(cx), "ag-t0"), "on_hover", false, cx);
  assert.equal(find(ag.render(cx), "pin-t0"), null);
  fire(find(ag.render(cx), "pin-vps/t2"), "on_click", {}, cx);
  assert.deepEqual([...f.state["agents.pins"]], ["vps/t2"], "pin acts on the selected remote button");
  const header = f.load("t3-chrome").render(cx);
  assert.deepEqual(header.items.map(n => n.key), ["tip-sidebar-mode", "tip-sidebar-toggle"], "the header holds the sidebar switch and toggle; search is a shortcut");
  assert.equal(header.style.pr + (26 - 14) / 2, 16, "the toggle's icon ends on the same line as the + and status column");
  fire(find(header, "sidebar-toggle"), "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["layout.toggle", { id: "sidebar" }]);
  const footer = f.load("t3-chrome", { footer: true });
  const settings = find(footer.render(cx), "settings");
  assert.deepEqual([settings.style.size, settings.items[0].style.size, settings.style.accessibility_label], [32, 16, "Settings"], "as T3's footer: 32px icon buttons");
  assert.equal(find(footer.render(cx), "app-update"), null, "no update, no restart");
  f.ui.updates = { app: { ready: "0.9.1" } };
  const update = find(footer.render(cx), "app-update");
  assert.deepEqual(strings(update), ["Update"]);
  fire(update, "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["app.update", {}]);
  f.ui.updates = { app: {} };
  const groups = ["pinned", "sp-s0"].map(id => find(ag.render(cx), id).style);
  assert.deepEqual([groups[0].h, "pt" in groups[0]], [22, false], "the first group sits under the heading like Spaces' first row");
  assert.deepEqual([groups[1].h, groups[1].pt], [30, 8], "later groups keep their 8px separation");
  fire(settings, "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["app.settings", {}]);
}

{
  const f = fixture(208), ag = f.load("t3-agents");
  for (const status of ["working", "blocked", "idle", "done"]) {
    const slot = ag.status(f.theme(), { status });
    assert.equal(slot.style.size, 20, `${status} keeps the same status column`);
    const mark = slot.items[0];
    assert.equal(mark.style.size + 2 * (mark.style.mx ?? 0), 14, `${status} mark is 14 wide, so centers line up`);
    assert.ok("justify_end" in slot.style && !("justify_center" in slot.style), "marks sit flush right in the slot");
    assert.equal(slot.handlers.on_click, undefined, "status remains an indicator, not a pin target");
  }
  const at = ag.render(cx), heading = find(at, "agents-heading");
  // Header icon: 14 inside a 26 button, inset by pr. Status mark: flush right inside list px 8 + row px 8.
  assert.equal(heading.style.pr + (26 - 14) / 2, 8 + find(at, "ag-t0").style.px, "status column ends under the header icons");
  assert.equal(heading.items[0].style.text_color, f.theme().muted, "section titles are a step brighter than group labels");
  assert.equal(find(at, "sp-s0").items[0].style.text_color, f.theme().dim);
  assert.equal(find(f.load("t3-spaces").render(cx), "spaces-heading").items[0].style.text_color, f.theme().muted);
}

{
  // A card from another machine says so as T3's does: a server mark before its program, the machine named on hover.
  const f = fixture(256), root = f.load("t3-inbox").render(cx);
  const card = find(root, "card-vps/t2"), mark = find(card, "machine-vps/t2");
  assert.ok(strings(find(root, "tip-machine-vps/t2")).includes("vps") === false && find(root, "tip-machine-vps/t2"), "its card waits for the hover");
  assert.ok(walk(mark).some(n => n.source === "mods/workspace-chrome/server.svg"));
  assert.ok(!strings(card).some(s => s.includes("vps")), "the machine isn't spelled out on the card");
  assert.equal(find(find(root, "card-t0"), "machine-t0"), null, "this computer's cards carry no mark");
}
{
  // The inbox: Working holds busy trees; Settle is by hand, undone by new work, never by looking.
  const f = fixture(256), inbox = f.load("t3-inbox"), run = { ...cx, spawn: fn => { fn(run); } };
  const remote = f.agents()[1], k = f.terminals().find(k => k.address === "vps/t2"), child = f.terminals().find(c => c.address === "child");
  child.status = "idle";
  assert.deepEqual(strings(find(inbox.render(run), "working-header")), ["Working", "1"], "a working tree moves down to Working");
  fire(find(inbox.render(run), "card-t0"), "on_hover", true, run);
  // Settle sits in the corner faded out, fading in over the state when it's offered (T3's group-hover crossfade).
  const hidden = find(inbox.render(run), "settle-t0"), labels = f.labelled.length;
  assert.ok(hidden.style.opacity === 0 && !("role" in hidden.style) && !hidden.handlers.on_click && !hidden.handlers["on_mouse_down:left"], "a working tree can't be settled: faded, its button takes no press");
  assert.equal(f.labelled.length, labels);
  assert.deepEqual(JSON.parse(JSON.stringify(hidden.style.transition)), ["opacity", { duration: 150, easing: "ease-out" }]);
  assert.equal(find(find(inbox.render(run), "card-t0"), "state-t0").style.opacity ?? 1, 1);
  remote.status = "done"; k.turn = 4;
  fire(find(inbox.render(run), "card-vps/t2"), "on_hover", true, run);
  const offered = inbox.render(run);
  assert.equal(find(offered, "settle-vps/t2").style.opacity, 1);
  assert.equal(walk(find(offered, "corner-vps/t2")).find(n => n.style.opacity === 0 && walk(n).some(c => c.key === "state-vps/t2" || strings(c).length)) != null, true, "the state fades out under it");
  fire(find(inbox.render(run), "settle-vps/t2"), "on_click", {}, run);
  const [, , value] = f.labelled.pop();
  assert.match(value, /^settled=\d+:4$/, "the label keeps when and the turn it was settled at");
  k.labels = { settled: value.slice(8) };
  const at = inbox.render(run);
  assert.ok(!find(at, "card-vps/t2") && strings(find(at, "settled-header")).includes("1"), "settled leaves the cards for the tail");
  {
    // The settle key (t3-inbox.settle) acts on the agent in view: a busy one stays, a settled one comes back, then goes again.
    const t0 = f.agents()[0], n = f.labelled.length;
    inbox.render(run); inbox.settleKey(run);
    assert.equal(f.labelled.length, n, "the key doesn't settle a working agent");
    t0.focused = false; remote.focused = true;
    inbox.render(run); inbox.settleKey(run);
    assert.deepEqual(f.labelled.pop(), ["label", "vps/t2", "settled="], "on a settled agent the key brings it back");
    inbox.render(run); inbox.settleKey(run);
    const [, , again] = f.labelled.pop();
    assert.match(again, /^settled=\d+:4$/, "and settles it again");
    k.labels = { settled: again.slice(8) };
    t0.focused = true; remote.focused = false;
  }
  {
    // Clear asks through Herdr's confirm dialog; only its answer closes settled panes.
    const n = f.calls.length;
    f.spaces()[0].tabs[0].active = true;
    fire(find(inbox.render(run), "settled-clear"), "on_hover", true, run);
    assert.equal(find(inbox.render(run), "settled-clear").style.text_color, "#f4f4f6", "lit under the pointer");
    fire(find(inbox.render(run), "settled-clear"), "on_click", {}, run);
    assert.equal(f.calls.length, n, "the click only asks");
    assert.notEqual(find(inbox.render(run), "settled-clear").style.text_color, "#f4f4f6", "the dialog hides the pointer's leaving from it: it doesn't stay lit");
    const { mod, kind, props } = f.overlays.pop();
    assert.deepEqual([mod, kind, props.title, props.command.name], ["confirm", "dialog", "Close 1 pane?", "t3-inbox.clear"]);
    f.panes().push({ pane: "p9", tab: "b2", terminal: "t9" });
    inbox.render(run); inbox.clearSettled();
    assert.deepEqual(f.calls.splice(n), [["pane.close", { pane: "p2" }], ["space.select", { id: "s0" }], ["tab.select", { id: "b0" }]], "another pane keeps the space");
    f.panes().pop();
    inbox.render(run); inbox.clearSettled();
    assert.deepEqual(f.calls.splice(n), [["tab.new", { space: "s2", folder: "/work/s2" }], ["pane.close", { pane: "p2" }],
      ["space.select", { id: "s0" }], ["tab.select", { id: "b0" }]], "an emptied space keeps a fresh shell tab where its terminal was, not where the space began");
    remote.focused = true;
    assert.equal(find(inbox.render(run), "settled-clear"), null, "the agent in view is never cleared");
    remote.focused = false;
  }
  remote.focused = true;
  inbox.render(run);
  assert.equal(f.labelled.length, 0, "looking doesn't bring it back");
  k.turn = 5;
  inbox.render(run);
  assert.deepEqual(f.labelled.pop(), ["label", "vps/t2", "settled="], "a turn ended since brings it back");
  // The space filter, as T3's project scope: picking a space hides the others' agents; All spaces brings them back.
  const scope = (id) => fire(find(find(inbox.render(run), "inbox-scope-menu").style.content, `scope-${id}`), "on_click", { modifiers: {} }, run);
  scope("s2");
  assert.ok(find(inbox.render(run), "card-vps/t2") && !find(inbox.render(run), "working-header"), "only the chosen space's agents");
  scope("all");
  assert.ok(find(inbox.render(run), "working-header"), "all spaces again");
  // The brand bar switches the sidebar; with the inbox showing, a settled agent's done is no news.
  fire(find(f.load("t3-chrome").render(cx), "sidebar-mode"), "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["layout.select", { stack: "sidebar-lists", child: "inbox" }]);
  f.slots["sidebar-lists"] = { id: "sidebar-lists", active: "inbox" };
  f.spaces()[0].tabs[0].status = "done"; f.agents()[0].status = "done";
  for (const k of f.terminals()) if (k.parent) k.status = "idle";
  f.terminals().find(c => c.address === "t0").labels = { settled: "1:0" };
  assert.equal(walk(find(f.load("t3-tabs").render(cx), "tab-b0")).some(n => n.style.rounded_full), false, "no done dot for a settled agent's tab");
  f.terminals().find(c => c.address === "t0").labels = { snoozed: String(Date.now() + 60000) };
  assert.equal(walk(find(f.load("t3-tabs").render(cx), "tab-b0")).some(n => n.style.rounded_full), false, "nor for a snoozed one's");
  // Snoozed with a sub-agent stuck, the Inbox shows it as needing the person, so the hidden sidebar's toggle counts it.
  f.terminals().find(c => c.address === "child").status = "error"; f.slots.sidebar.hidden = true;
  const stuck = () => strings(find(f.load("t3-tabs").render(cx), "agents-blocked"));
  const snoozedCount = stuck();
  f.terminals().find(c => c.address === "t0").labels = {};
  assert.deepEqual(snoozedCount, stuck(), "the same count, snoozed or not");
  delete f.slots.sidebar.hidden;
}

{
  // A parent's unread reply shows first, its working sub-agents beside it; once read, waiting on them is
  // working, everywhere, for as long as the longest-working one has worked.
  const f = fixture(256), inbox = f.load("t3-inbox");
  f.agents()[0].status = "idle"; f.terminals().find(c => c.address === "child").status = "idle";
  f.terminals().find(c => c.address === "grandchild").status_ms = Date.now() - 90000;
  assert.deepEqual(strings(find(inbox.render(cx), "state-t0")), ["Working", "1m"], "the waiting parent shows its sub-agent's working time");
  f.agents()[0].status = "done"; f.panes()[0].status = "done";
  const drawn = inbox.render(cx);
  assert.ok(strings(find(drawn, "state-t0")).includes("Done") && strings(drawn).includes("1 sub-agent working"), "an unread reply isn't hidden by a working sub-agent");
  assert.equal(find(f.load("t3-agents").render(cx), "status-t0").style.accessibility_label, "Done");
  assert.ok(walk(find(f.load("t3-tabs").render(cx), "tab-b0")).some(n => n.style.rounded_full), "its tab shows the done dot");
  f.agents()[0].status = "idle"; f.panes()[0].status = "idle";
  assert.deepEqual(strings(find(inbox.render(cx), "state-t0")), ["Working", "1m"], "read, the run goes on from its start");
  assert.equal(find(f.load("t3-agents").render(cx), "status-t0").style.accessibility_label, "Working (sub-agent)", "a read parent waiting on a sub-agent is working");
  const spins = tree => walk(tree).some(n => n.source === "mods/workspace-chrome/spinner.svg");
  assert.ok(spins(find(f.load("t3-tabs").render(cx), "tab-b0")) && spins(f.load("t3-pane", { pane: "p0" }).render(cx)), "its tab and pane header show it working");
}

{
  // A mod pane's word marks its tab as an agent's would; a closed pane's says nothing.
  const f = fixture(256);
  const spins = tree => walk(tree).some(n => n.source === "mods/workspace-chrome/spinner.svg");
  f.spaces()[0].tabs.push({ id: "bx", name: "review", named: true, active: false });
  f.panes().push({ pane: "p9", terminal: null, mod: "review", tab: "bx", title: "review" });
  const tab = () => find(f.load("t3-tabs").render(cx), "tab-bx");
  assert.ok(!spins(tab()) && !strings(tab()).includes("!") && !walk(tab()).some(n => n.style.rounded_full), "nothing reported, no mark");
  f.state["review.status"] = { bx: "working" };
  assert.ok(spins(tab()), "a run shows the spinner");
  f.state["review.status"] = { bx: "blocked" };
  assert.ok(strings(tab()).includes("!"), "a failure shows the badge");
  f.state["review.status"] = { bx: "done" };
  assert.ok(walk(tab()).some(n => n.style.rounded_full), "a finished run shows the dot");
  f.state["review.status"] = { bx: "working" };
  f.panes().pop();
  assert.ok(!spins(tab()), "its pane closed, its word is left behind");
}

{
  // Dragging, as T3's sidebar: labels and gaps open only while a row is lifted; Pinned pins and reorders,
  // Active unpins and unsettles, Settled settles; empty sections take drops; Esc, leaving, or a row
  // vanishing put it back; Working never lifts; a sweep from Settle or undo takes a run of rows along.
  const f = fixture(256), run = { ...cx, spawn: fn => { fn(run); } }, inbox = f.load("t3-inbox");
  for (const a of f.agents()) { a.status = "done"; a.focused = false; }
  for (const k of f.terminals()) if (k.parent) k.status = "idle";
  const t0 = f.terminals().find(k => k.address === "t0");
  const pins = () => [...(f.state["agents.pins"] ?? [])];
  const root = () => inbox.render(run);
  const h = (id) => find(root(), id)?.style.h;
  const badge = (v) => find(find(root(), "drag-ghost"), `badge-${v}`);
  // Press 10px into an 80px row, then move: the sidebar sees the pointer at y.
  const lift = (from, y = 20) => {
    fire(find(root(), from), "on_mouse_down:left", { position: { x: 0, y: 0 }, local_position: { x: 0, y: 10 }, bounds: { height: 80 } }, run);
    fire(root(), "on_mouse_move", { position: { x: 0, y }, local_position: { x: 0, y: 100 + y } }, run);
  };
  const over = (to, y = 10) => fire(find(root(), to), "on_mouse_move", { local_position: { x: 0, y }, bounds: { height: 80 } }, run);
  const release = () => fire(root(), "on_mouse_up:left", {}, run);
  const drag = (from, to, y) => { lift(from); over(to, y); release(); };

  assert.equal(h("pinned"), 0, "no Pinned or Active label until something is lifted");
  f.shown.pane = "p9";
  lift("card-t0", 5);
  assert.equal(find(root(), "drag-ghost"), null, "under 6px it's still a click");
  release();
  lift("card-vps/t2");
  assert.ok(find(find(root(), "drag-ghost"), "ghost-card-vps/t2"), "the lifted card follows the pointer");
  assert.equal(find(root(), "drag-ghost").style.top, 110, "the pressed spot stays under the pointer");
  assert.equal(h("pinned"), 24); assert.equal(h("active"), 24, "the labels open while it's lifted");
  assert.equal(h("hold-vps/t2"), 82, "it holds its place, spacing included");
  assert.equal(badge("pin"), null, "over its own section it says nothing");
  over("pinned");
  assert.equal(h("hold-vps/t2"), 0, "headed elsewhere, its place folds");
  assert.equal(h("gap-head-pinned"), 82, "and empty Pinned opens a gap under its label");
  assert.ok(badge("pin"), "the lifted card says Pin");
  release();
  assert.deepEqual(pins(), ["vps/t2"]);
  assert.ok(find(f.load("t3-agents").render(cx), "pinned"), "the agents list shows the same pin");
  assert.deepEqual(f.calls.pop(), ["pane.focus", { pane: "p9" }], "letting go hands the keyboard back to the pane that had it");
  assert.equal(h("pinned"), 0, "the labels close again");
  assert.ok(walk(find(root(), "card-vps/t2")).some(n => n.source === "mods/workspace-chrome/pin.svg"), "a pin shows its glyph");

  lift("card-t0"); over("card-vps/t2", 10);
  assert.equal(h("gap-vps/t2"), 82, "the upper half of a pin opens a gap above it");
  over("card-vps/t2", 60);
  assert.equal(h("gap-vps/t2"), 0);
  assert.equal(h("gap-end-pinned"), 82, "the lower half opens it below");
  assert.deepEqual(JSON.parse(JSON.stringify(find(root(), "gap-end-pinned").style.transition)), ["height", { duration: 150, easing: "ease-out" }], "gaps slide natively");
  release();
  assert.deepEqual(pins(), ["vps/t2", "t0"]);
  lift("card-t0"); over("card-vps/t2", 10);
  assert.equal(badge("pin"), null, "reordering pins says nothing");
  release();
  assert.deepEqual(pins(), ["t0", "vps/t2"], "within Pinned it reorders");
  drag("card-t0", "card-t0", 70);
  assert.deepEqual(pins(), ["t0", "vps/t2"], "back over its own place, nothing changes");

  lift("card-t0");
  assert.ok(find(root(), "active-placeholder"), "empty Active shows a dashed drop target");
  over("active-placeholder");
  assert.equal(find(root(), "active-placeholder"), null);
  assert.equal(h("gap-head-active"), 82, "targeted, it opens a gap instead");
  assert.ok(badge("unpin"));
  release();
  assert.deepEqual(pins(), ["vps/t2"], "onto Active unpins");

  lift("card-t0");
  assert.ok(find(root(), "settled-header") && find(root(), "settled-placeholder"), "Settled shows while dragging, even empty");
  over("settled-header");
  assert.ok(badge("settle"));
  release();
  const [, addr, value] = f.labelled.pop();
  assert.equal(addr, "t0");
  assert.match(value, /^settled=\d+:/, "dropped on Settled, it's settled");
  t0.labels = { settled: value.slice(8) };
  inbox.open = true;
  // As T3's settled rows, it leads with its project's mark, the one its card shows, not its program's icon.
  const mark = find(root(), "slim-mark-t0");
  assert.deepEqual(strings(mark), ["P"], "project 0's monogram");
  assert.ok(!walk(mark).some(n => n.kind === "svg" && n.source === "icons/pi.svg"), "no program icon");
  lift("slim-t0");
  assert.ok(find(find(root(), "drag-ghost"), "ghost-slim-t0"), "a settled row lifts as its row");
  over("card-vps/t2", 10);
  assert.equal(h("gap-vps/t2"), 84, "the gap is the destination's: a card");
  assert.ok(badge("pin"), "a settled row can be pinned");
  over("active-rest");
  assert.equal(h("gap-head-active"), 84, "the empty space above the shelves counts as Active");
  assert.ok(badge("unsettle"));
  release();
  assert.deepEqual(f.labelled.pop(), ["label", "t0", "settled="], "dropped on Active, it's unsettled");
  assert.deepEqual(pins(), ["vps/t2"]);
  lift("card-t0");
  assert.equal(find(root(), "drag-ghost"), null, "a row whose change hasn't landed yet stays put");
  release();
  t0.labels = {};

  f.state["agents.pins"] = [];
  fire(find(root(), "card-t0"), "on_hover", true, run);
  const settleButton = find(root(), "settle-t0");
  fire(settleButton, "on_mouse_down:left", { position: { x: 0, y: 0 } }, { ...run, stop_propagation() {} });
  fire(root(), "on_mouse_move", { position: { x: 0, y: 20 }, local_position: { x: 0, y: 120 } }, run);
  over("card-vps/t2");
  assert.ok(find(find(root(), "card-t0"), "badge-settle") && find(find(root(), "card-vps/t2"), "badge-settle"), "a sweep from Settle marks the run");
  assert.equal(find(root(), "drag-ghost"), null, "a sweep lifts nothing");
  release();
  assert.deepEqual(f.labelled.splice(0).map(([, a, v]) => [a, v.split("=")[0]]).sort(), [["t0", "settled"], ["vps/t2", "settled"]], "letting go settles every marked row");
  fire(settleButton, "on_click", {}, run);
  assert.equal(f.labelled.length, 0, "the button's click after a sweep doesn't settle again");
  // As core writes them back: the label the settle set, else the row stays pending and won't lift (its stamp is ms).
  for (const k of [t0, f.terminals().find(k => k.address === "vps/t2")]) k.labels = { settled: inbox.pending[k.address] ?? `${Date.now()}:0` };

  const n = f.labelled.length;
  lift("slim-vps/t2"); over("active");
  fire(root(), "on_key_down", { keystroke: "escape" }, run);
  assert.equal(find(root(), "drag-ghost"), null, "Esc puts it back");
  release();
  lift("slim-vps/t2"); over("active");
  fire(root(), "on_hover", false, run);
  assert.equal(find(root(), "drag-ghost"), null, "leaving off a side puts it back");
  release();
  const before = f.calls.length;
  lift("slim-vps/t2"); over("active");
  assert.ok(find(root(), "drag-ghost"), "the drag is under way before its row leaves");
  const gone = f.agents().splice(1, 1)[0];
  assert.equal(find(root(), "drag-ghost"), null, "a row that leaves the list ends the drag");
  f.agents().push(gone);
  release();
  assert.deepEqual(f.calls.slice(before), [["pane.focus", { pane: "p9" }]], "and the release still hands the keyboard back");
  assert.equal(f.labelled.length, n, "none of those changed anything");
  // Off the bottom edge, past the Settled shelf, it lands where the badge said (Herdr reports no release outside).
  fire(root(), "on_size_change", { width: 256, height: 900 }, run);
  for (const k of f.terminals()) if (k.address === "vps/t2") k.labels = {};
  lift("card-vps/t2");
  fire(root(), "on_mouse_move", { position: { x: 0, y: 40 }, local_position: { x: 130, y: 895 } }, run);
  over("settled-header");
  fire(root(), "on_hover", false, run);
  assert.equal(find(root(), "drag-ghost"), null);
  assert.deepEqual(f.labelled.pop()?.slice(0, 2), ["label", "vps/t2"], "leaving off the bottom settles it");
  const calls = f.calls.length;
  lift("slim-vps/t2"); over("slim-vps/t2");
  fire(find(root(), "slim-vps/t2"), "on_click", {}, run);
  release();
  assert.ok(!f.calls.slice(calls).some(([name]) => name === "agent.focus"), "a drag's release doesn't open the row");

  const old = fixture(256);
  old.stores.set("t3-agents", new Map([["pins", '["t0"]']]));
  old.load("t3-agents");
  assert.deepEqual([...old.state["agents.pins"]], ["t0"], "older pins move to the shared set, so a drag in the inbox keeps them");

  const w = fixture(256), wf = w.load("t3-inbox");
  for (const k of w.terminals()) if (k.parent) k.status = "idle";
  fire(find(wf.render(cx), "card-t0"), "on_mouse_down:left", { position: { x: 0, y: 0 }, local_position: { x: 0, y: 10 }, bounds: { height: 80 } }, cx);
  fire(wf.render(cx), "on_mouse_move", { position: { x: 0, y: 30 }, local_position: { x: 0, y: 130 } }, cx);
  assert.equal(find(wf.render(cx), "drag-ghost"), null, "a working card doesn't lift");
}

{
  const f = fixture(256), sp = f.load("t3-spaces"), ag = f.load("t3-agents");
  let root = sp.render(cx);
  // The Spaces/Agents divider is the layout's own, as upstream: neither list sizes it.
  for (const tree of [root, ag.render(cx)]) assert.equal(walk(tree).filter(n => "on_size_change" in n.handlers).length, 0, "no list measures itself to move the divider");
  assert.ok(!f.calls.some(([name]) => name === "layout.resize"), "rendering never resizes the layout");
  root = sp.render(cx);
  fire(find(root, "space-s0"), "on_mouse_down:left", {}, cx);
  fire(find(root, "space-s1"), "on_mouse_move", {}, cx);
  fire(find(root, "space-s1"), "on_mouse_up:left", {}, cx);
  assert.deepEqual(f.calls.pop(), ["space.move", { id: "s0", index: 2 }]);
  const n2 = f.calls.length;
  fire(find(root, "space-s0"), "on_mouse_down:left", {}, cx);
  fire(find(root, "space-s2"), "on_mouse_move", {}, cx);
  fire(find(root, "space-s2"), "on_mouse_up:left", {}, cx);
  assert.equal(f.calls.length, n2, "cross-machine drag remains rejected");
}

{
  const f = fixture(240), ag = f.load("t3-agents"), sp = f.load("t3-spaces");
  const worktree = sp.row({ w: f.spaces()[1], i: 1, g: null, tree: "└─" }, f.theme());
  assert.equal(inFlow(worktree)[0].style.pl, 20, "worktree icon lines up with a sub-agent's");
  assert.equal(inFlow(worktree)[0].items[0].style.size, 18);
  const treeLines = row => row.items.filter(n => "absolute" in n.style).map(n => [n.style.left, "border_b" in n.style ? "elbow" : "line"]);
  assert.deepEqual(treeLines(worktree), [[16.25, "elbow"]], "last worktree turns in from under its checkout");
  assert.deepEqual(treeLines(sp.row({ w: f.spaces()[1], i: 1, g: null, tree: "├─" }, f.theme())), [[16.25, "line"], [16.25, "elbow"]], "a middle worktree keeps the line going");
  assert.deepEqual(treeLines(sp.row({ w: f.spaces()[1], i: 1, g: null, tree: null }, f.theme())), [], "checkouts draw no lines");
  {
    // project 1 is a worktree of project 0's repo.
    const g = { repo: "/r", linked: false, name: "project 0", branch: "main", ahead: 0, behind: 0 };
    sp.git[JSON.stringify([null, "/work/s0"])] = g;
    sp.git[JSON.stringify([null, "/work/p1"])] = { ...g, linked: true, branch: "x" };
    const ids = () => [...sp.ordered().map(r => r.w.id)];
    assert.deepEqual(ids(), ["s0", "s1", "s2"]);
    const arrow = find(sp.render(cx), "space-fold-s0");
    assert.deepEqual([arrow.items[0].source, arrow.items.length], ["mods/workspace-chrome/chevron-down.svg", 1], "a checkout shows its fold arrow at the end, as an agent parent");
    assert.equal(arrow.style.text_color, f.theme().dim, "the arrow is dim");
    fire(arrow, "on_hover", true, cx);
    assert.equal(find(sp.render(cx), "space-fold-s0").items[0].style.text_color, f.theme().foreground, "hovered, it brightens");
    fire(arrow, "on_hover", false, cx);
    let stopped = false;
    fire(arrow, "on_mouse_down:left", {}, { ...cx, stop_propagation() { stopped = true; } });
    assert.ok(stopped, "pressing the arrow neither selects nor drags the space");
    const before = f.calls.length;
    fire(arrow, "on_click", {}, cx);
    assert.deepEqual(ids(), ["s0", "s2"], "folding hides the worktrees");
    assert.equal(f.calls.length, before, "folding runs no command");
    assert.equal(f.stores.get("t3-spaces").get("repos.folded"), JSON.stringify(["/r"]), "folding persists");
    const count = find(sp.render(cx), "space-fold-s0");
    assert.equal(count.items[0].source, "mods/workspace-chrome/chevron-right.svg");
    assert.deepEqual([count.items[1], count.style.text_color], ["1", f.theme().dim], "folded, a dim count says how many");
    fire(count, "on_click", {}, cx);
    assert.deepEqual(ids(), ["s0", "s1", "s2"], "the count unfolds them");
    assert.equal(find(sp.render(cx), "space-fold-s0").items.length, 1);
    sp.git = {};
  }
  {
    // A worktree away from its checkout: the model moves to the rows' order, so space keys go down the list.
    const o = fixture(256), list = o.spaces(), view = o.load("t3-spaces");
    list[2].machine = null;
    const g = { repo: "/r", linked: false, name: "project 0", branch: "main", ahead: 0, behind: 0 };
    view.git[JSON.stringify([null, "/work/s0"])] = g;
    view.git[JSON.stringify([null, "/work/s2"])] = { ...g, linked: true, branch: "x" };
    const moves = () => o.calls.filter(([name]) => name === "space.move");
    const ids = () => [...view.ordered().map(r => r.w.id)];
    assert.deepEqual(ids(), ["s0", "s2", "s1"]);
    assert.deepEqual(moves(), [["space.move", { id: "s2", index: 2 }]], "the worktree moves under its checkout");
    ids();
    assert.equal(moves().length, 1, "a move is queued once");
    view.ordering.at -= 1000;
    ids();
    assert.equal(moves().length, 2, "a write that lost a sync conflict is retried");
    list.splice(1, 0, list.splice(2, 1)[0]); // The move's echo.
    ids();
    assert.equal(view.ordering, null, "in order, nothing is pending");
    view.foldedRepos.add("/r");
    assert.deepEqual(ids(), ["s0", "s1"], "folding hides the worktree");
    assert.equal(moves().length, 2, "folding moves nothing");
    list.push(list.splice(1, 1)[0]);
    assert.deepEqual(ids(), ["s0", "s1"]);
    assert.deepEqual(moves().pop(), ["space.move", { id: "s2", index: 2 }], "a folded worktree still keeps its place");
    list.splice(1, 0, list.splice(2, 1)[0]);
    view.foldedRepos.clear();
    // A drag holds its space, not an index a move can shift under it.
    const rows = view.render(cx);
    fire(find(rows, "space-s1"), "on_mouse_down:left", {}, cx);
    list.push(list.shift());
    fire(find(rows, "space-s0"), "on_mouse_move", {}, cx);
    fire(find(rows, "space-s0"), "on_mouse_up:left", {}, cx);
    assert.deepEqual(o.calls.pop(), ["space.move", { id: "s1", index: 3 }]);
  }
  delete f.agents()[0].program.icon;
  ag.toggleFold("t0", cx);
  const tree = ag.render(cx);
  assert.equal(find(tree, "ag-t0").items[0].style.size, 18, "missing icons do not shift names");
  assert.equal(inFlow(find(tree, "sub-child"))[0].style.size, 18);
  fire(find(tree, "agent-fold-t0"), "on_click", {}, cx);
  assert.equal(find(ag.render(cx), "sub-grandchild"), null, "missing icons do not disable folding");
  const menu = f.load("t3-agents", { sortMenu: true }).render(cx);
  assert.equal(find(menu, "sort-grouped").style.bg, f.theme().selected);
  assert.equal(find(menu, "sort-grouped").hoverStyle.bg, undefined);
  fire(find(menu, "sort-priority"), "on_click", {}, cx);
  assert.equal(f.state["agents.sort"], "priority");
  const byPriority = find(ag.render(cx), "ag-t0"), names = byPriority.items[1];
  assert.deepEqual(strings(names), ["local task", "project 0"], "without a space header the task leads and its space follows; the address stays in the pane header");
  assert.deepEqual([names.items[1].style.text_color, names.items[1].style.text_size, names.items[1].style.flex_shrink], [f.theme().dim, 12, 1000], "the space is dim, smaller, and gives way first");
}

{
  const f = fixture(256), first = f.spaces()[0].tabs[0];
  Object.assign(first, { active: true, status: "working" });
  f.spaces()[0].tabs.push({ id: "other", name: "other task", active: false });
  const tabs = f.load("t3-tabs"), root = tabs.render(cx);
  assert.equal(find(root, "tab-b0").hoverStyle.bg, undefined);
  assert.equal(find(root, "tab-other").hoverStyle.bg, f.theme().hover);
  assert.equal(find(root, "tab-strip").style.gap, 4);
  // Tabs take their whole names while the room allows, the longest give way first; past that the strip keeps the active tab in view.
  {
    const strip = f.spaces()[0].tabs, kept = strip.splice(0), view = f.load("t3-tabs");
    strip.push(...["a", "b", "c", "d"].map(id => ({ id, name: id, active: id === "a" })));
    const at = () => Math.abs(find(view.render(cx), "tab-strip").style.ml);
    const w = (id) => find(view.render(cx), `tab-${id}`).style.w;
    const pick = (id) => strip.forEach(c => { c.active = c.id === id; });
    const room = (width) => fire(find(view.render(cx), "tab-scroll"), "on_size_change", { width }, cx);
    const wheel = (x, y) => fire(view.render(cx), "on_scroll_wheel", { delta: { x, y } }, cx);
    // A name's width, so its tab is `whole` wide: 33 around the name.
    const name = (id, whole) => fire(find(view.render(cx), `name-${id}`), "on_size_change", { width: whole - 33 }, cx);
    assert.equal(w("a"), 144, "before its name is measured");
    assert.equal(find(view.render(cx), "name-a").style.h, 0, "the measure doesn't show");
    for (const id of "abcd") name(id, 300);
    room(1212);
    assert.deepEqual([..."abcd"].map(w), [300, 300, 300, 300], "room for them all: every name whole");
    room(1012);
    assert.deepEqual([..."abcd"].map(w), [250, 250, 250, 250], "too little: they share it");
    name("b", 100);
    room(812);
    assert.deepEqual([..."abcd"].map(w), [240, 100, 230, 230], "a short name keeps its width, the active tab holds 240, the long ones share the rest");
    room(500);
    assert.deepEqual([..."abcd"].map(w), [240, 100, 144, 144], "squeezed: the active tab stops at 240, the rest at 144, and the strip scrolls");
    pick("b");
    assert.deepEqual([..."abcd"].map(w), [144, 100, 144, 144], "a short active tab asks for no more");
    name("b", 33 + 14);
    assert.equal(w("b"), 96, "a name as short as `Pi` still gets a tab 96px wide");
    for (const id of "abcd") name(id, 100);
    pick("a");
    room(250);
    assert.equal(at(), 0, "the first tab is at its place");
    pick("d");
    assert.equal(at(), 162, "the last tab lands at the right edge: 4 tabs, 3 gaps, 250 of room");
    pick("b");
    assert.equal(at(), 104, "an earlier tab lands at the left edge");
    pick("c");
    assert.equal(at(), 104, "one already in view doesn't move the strip");
    wheel(-30, 0);
    assert.equal(at(), 134, "a swipe moves the strip");
    assert.equal(at(), 134, "and the next render doesn't pull it back");
    f.calls.length = 0;
    wheel(0, 3);
    assert.deepEqual(f.calls.splice(0), [["tab.prev", {}]], "the wheel still walks the tabs");
    assert.equal(at(), 134);
    wheel(-10000, 0);
    assert.equal(at(), 162, "a swipe stops at the last tab");
    wheel(10000, 0);
    assert.equal(at(), 0, "and at the first");
    // Its name lengthening moves the strip for its new end; another tab's doesn't.
    pick("d");
    assert.equal(at(), 162);
    name("d", 200);
    assert.equal(at(), 262, "the active tab's end stays in view");
    name("a", 120);
    assert.equal(at(), 262, "another tab's width doesn't move the strip");
    name("a", 100);
    pick("b");
    room(60);
    assert.equal(at(), 104, "a tab wider than the room shows its start");
    room(1000);
    pick("d");
    assert.equal(at(), 0, "with room for every tab the strip stays put");
    strip.splice(0, strip.length, ...kept);
  }
  // A tab nobody named reads as its agent, the name its pane header and inbox card show.
  Object.assign(first, { name: "1", named: false });
  f.terminals().find(k => k.address === "t0").labels = { "pi.session": "mine" };
  assert.ok(strings(find(f.load("t3-tabs").render(cx), "tab-b0")).includes("mine"), "an unnamed tab reads as its agent's session");
  assert.ok(strings(f.load("t3-pane", { pane: "p0" }).render(cx)).includes("mine"), "its pane header reads the same");

  // New opens a terminal tab in the space picked: no agent step.
  const menu = f.load("t3-new-menu"); f.calls.length = 0;
  menu.choose(menu.items().find(item => item.space?.id === f.spaces()[0].id));
  assert.deepEqual(f.calls.splice(0), [["tab.new", { space: f.spaces()[0].id }]], "New opens a tab");
  // Two machines: New space asks which, as T3's Add project asks for an environment.
  fire(find(menu.render(cx), "space-new"), "on_click", {}, cx);
  assert.deepEqual(f.calls, [], "New space asks first");
  menu.choose(menu.items().find(item => item.machine === "vps"));
  assert.deepEqual(f.calls.pop(), ["space.new", { machine: "vps" }], "New space opens a space there");
  f.calls.length = 0;
  {
    // The sidebar's way to a new machine, in the footer both Lists and Inbox keep.
    const f = fixture(256);
    const add = find(f.load("t3-chrome", { footer: true }).render(cx), "add-machine");
    assert.equal(add.style.accessibility_label, "Add machine");
    fire(add, "on_click", {}, cx);
    assert.deepEqual(f.calls.pop(), ["mod.open", { name: "machine-add" }]);
  }
  {
    // "+" on a machine's header names that machine, this computer included: without one the focused space's machine wins.
    const f = fixture(256), sp = f.load("t3-spaces");
    sp.machines = [{ name: "vps", state: "connected" }];
    fire(find(sp.render(cx), "machine-add-local"), "on_click", {}, cx);
    assert.deepEqual(f.calls.pop(), ["space.new", { machine: "" }]);
    fire(find(sp.render(cx), "machine-add-vps"), "on_click", {}, cx);
    assert.deepEqual(f.calls.pop(), ["space.new", { machine: "vps" }]);
  }
  assert.equal(find(root, "sidebar-toggle"), null, "with the sidebar shown its own header has the toggle");
  f.slots.sidebar.hidden = true;
  const bare = tabs.render(cx);
  assert.deepEqual(bare.items.slice(0, 2).map(n => n.key), ["tip-sidebar-toggle", "tab-scroll"], "hidden, the toggle sits first, after the window buttons");
  const toggle = find(bare, "sidebar-toggle");
  // t0 works, but its sub-agent is stuck: it needs the person too.
  assert.deepEqual(toggle.items.slice(1).map(n => [n.key, strings(n)]), [["agents-blocked", ["!", "2"]]], "hidden, the toggle sums up agents most urgent first, idle left out");
  assert.equal(toggle.style.accessibility_label, "Show sidebar, 2 needing you");
  {
    // One look across the preset: the same "needs you" mark everywhere, no scrollbars, English throughout.
    f.spaces()[0].tabs[0].status = "blocked";
    f.panes()[0].status = "blocked";
    const all = () => [tabs.render(cx), f.load("t3-agents").render(cx), f.load("t3-spaces").render(cx), f.load("t3-chrome").render(cx), f.load("t3-pane", { pane: "p0" }).render(cx)].flatMap(walk);
    const look = n => { const { accessibility_label, ...s } = n.style; return JSON.stringify([s, strings(n)]); };
    const marks = all().filter(n => strings(n).join("") === "!" && n.style.size === 14);
    assert.ok(marks.length >= 3, "tabs, the agents list and the pane header all show needs-you");
    assert.equal(new Set(marks.map(look)).size, 1, "needs-you is drawn the same everywhere");
    assert.ok(!all().some(n => Object.keys(n.style).some(k => k.includes("scrollbar"))), "lists scroll without a painted bar");
    assert.ok(!all().some(n => /\p{Script=Han}/u.test(strings(n).join("") + (n.style.accessibility_label ?? ""))), "UI text and labels are English");
    delete f.spaces()[0].tabs[0].status; f.panes()[0].status = "working";
  }
  const saved = f.agents().map(a => a.status);
  f.agents().forEach(a => { a.status = "idle"; });
  for (const k of f.terminals()) if (k.parent) k.status = "idle";
  assert.deepEqual(find(tabs.render(cx), "sidebar-toggle").items.length, 1, "with nothing to report it is just the icon");
  f.agents().forEach((a, i) => { a.status = saved[i]; });
  fire(find(bare, "sidebar-toggle"), "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["layout.toggle", { id: "sidebar" }]);
  delete f.slots.sidebar.hidden;
  fire(find(root, "tab-b0"), "on_mouse_down:left", { click_count: 1 }, cx);
  fire(find(root, "tab-other"), "on_mouse_up:left", {}, cx);
  assert.deepEqual(f.calls.pop(), ["tab.move", { id: "b0", index: 2 }]);
  fire(find(root, "tab-other"), "on_mouse_down:right", {}, cx);
  assert.equal(f.overlays.pop().props.target.id, "other");
  // + and the window's buttons are the bar's end, a block of their own after the other mods' controls, sized to fit.
  assert.equal(find(root, "tab-new"), null);
  const end = f.load("t3-tabs", { part: "end", block: "tabs-end" });
  fire(find(end.render(cx), "tab-new"), "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["tab.new", {}], "the tab bar's + opens a tab in its space");
  f.calls.length = 0;
  fire(find(end.render(cx), "tabs-end"), "on_size_change", { width: 34 }, cx);
  fire(find(end.render(cx), "tabs-end"), "on_size_change", { width: 34 }, cx);
  assert.deepEqual(f.calls.splice(0), [["layout.resize", { id: "tabs-end", px: 34 }]], "once per change");
  f.scopes.get("t3-tabs").window = () => ({ platform: "windows", buttons: true });
  assert.deepEqual(find(end.render(cx), "tabs-end").items.map(n => n.key), ["tip-tab-new", "tip-minimize", "tip-maximize", "tip-close-window"], "the window's buttons stay last");
  // The strip under the work column says whether the bar's controls fold, at 1024.
  const measure = f.load("t3-tabs", { part: "measure" });
  fire(find(measure.render(cx), "bar-measure"), "on_size_change", { width: 1023 }, cx);
  assert.equal(f.scopes.get("t3-tabs").shared("bar.compact"), true);
  fire(find(measure.render(cx), "bar-measure"), "on_size_change", { width: 1024 }, cx);
  assert.equal(f.scopes.get("t3-tabs").shared("bar.compact"), false);
  fire(find(measure.render(cx), "bar-measure"), "on_size_change", { width: 0 }, cx);
  measure.close();
  assert.equal(f.scopes.get("t3-tabs").shared("bar.compact"), false, "gone with its layout, it leaves no bar compact");
  fire(find(root, "close-b0"), "on_click", {}, cx);
  assert.deepEqual(f.calls.pop(), ["t3-tabs.close-tab:b0", {}], "the × goes through the tab bar's answer");
  const pane = f.load("t3-pane", { pane: "p0" });
  pane.hovered = true;
  const head = pane.render(cx);
  const spinner = tree => walk(tree).find(n => n.source === "mods/workspace-chrome/spinner.svg");
  const open = f.load("t3-agents");
  for (const tree of [tabs.render(cx), head, open.render(cx)]) assert.equal(spinner(tree).style.text_color, f.theme().working);
  for (const id of ["ph-r-p0", "ph-d-p0", "ph-z-p0", "ph-x-p0"]) assert.equal(find(head, id).style.size, 26);
  const actions = walk(head).find(n => n.items.some(child => child?.key === "tip-ph-r-p0"));
  assert.equal(actions.style.gap, 4);
  assert.ok("flex_none" in actions.style, "narrow panes keep the action targets at their full size");
  assert.ok("absolute" in actions.style, "hovering a pane's header moves nothing else");
}
{
  // Icons: every UI glyph drawn is a file that exists.
  const f = fixture(256);
  f.spaces()[0].tabs[0].status = "blocked";
  const trees = [f.load("t3-tabs").render(cx), f.load("t3-tabs", { part: "end" }).render(cx), f.load("t3-agents").render(cx), f.load("t3-spaces").render(cx), f.load("t3-chrome").render(cx), f.load("t3-chrome", { footer: true }).render(cx), f.load("t3-pane", { pane: "p0" }).render(cx)].flatMap(walk);
  const glyphs = trees.filter(n => n.kind === "svg").map(n => n.source).filter(s => !s.endsWith("/spinner.svg") && s !== "icons/pi.svg");
  assert.ok(glyphs.length >= 5);
  for (const s of glyphs) {
    assert.ok(fs.existsSync(path.join(path.dirname(modRoot), s)), `icon on disk: ${s}`);
  }
}
(async () => {
  {
    // A rebuilt machine: one click forgets it and pairs again, and a failed pairing can be retried without forgetting twice.
    const f = fixture(256);
    let done;
    const run = { ...cx, spawn: fn => { done = fn(run); } };
    const sp = f.load("t3-spaces"), vps = { name: "vps", target: "me@vps:2222", session: "main", state: "unreachable", why: 'a different core answers there ("c2")' };
    sp.machines = [{ ...vps, why: "connection refused" }];
    assert.equal(find(sp.render(run), "machine-connect-vps"), null, "only a different core offers Connect");
    assert.ok(find(sp.render(run), "space-s2"), "a machine that's merely away keeps its spaces");
    sp.machines = [vps];
    assert.equal(find(sp.render(run), "space-s2"), null, "a rebuilt machine's old spaces aren't offered");
    assert.ok(!("tooltip" in find(sp.render(run), "machine-connect-vps").style), "Connect says itself, no hover tooltip");
    const asks = () => f.labelled.splice(0).filter(a => a[1] !== "ls");
    const add = ["machine", "add", "me@vps:2222", "--name", "vps", "--session", "main", "--json"];
    f.answerHc(a => a[1] === "add" ? { code: 1, stdout: '{"error":{"message":"no route"}}' } : { code: 0, stdout: '{"machines":[]}' });
    fire(find(sp.render(run), "machine-connect-vps"), "on_click", {}, run);
    await done;
    assert.deepEqual(asks(), [["machine", "rm", "vps", "--json"], add]);
    assert.ok(strings(find(sp.render(run), "machine-vps")).includes("no route"), "it stays listed, saying why, though the machine is forgotten");
    f.answerHc(() => ({ code: 0, stdout: '{"machines":[]}' }));
    fire(find(sp.render(run), "machine-connect-vps"), "on_click", {}, run);
    await done;
    assert.deepEqual(asks(), [add], "a retry doesn't forget it again");
    assert.deepEqual(Object.keys(sp.reconnecting), [], "paired, nothing's left to repair");
  }
  {
    // A hover style's color reaches text but never an svg: Herdr colors an icon as it builds the tree. So a button with an icon brightens by state.
    const f = fixture(256), views = [f.load("t3-chrome"), f.load("t3-chrome", { footer: true }), f.load("t3-tabs"), f.load("t3-pane", { pane: "p0" }), f.load("t3-spaces"), f.load("t3-agents"), f.load("t3-inbox"), f.load("t3-tabs", { part: "end" })];
    fire(views[3].render(cx), "on_hover", true, cx); // A pane's buttons show while its header is hovered.
    for (const view of views) for (const n of walk(view.render(cx))) if (n.hoverStyle.text_color) assert.ok(!walk(n).some(c => c.kind === "svg"), `${n.key}: a hover style can't brighten its icon`);
    const rest = f.theme().dim, bright = f.theme().foreground;
    for (const [view, id] of [[views[0], "sidebar-mode"], [views[1], "add-machine"], [views[7], "tab-new"], [views[4], "space-new"], [views[5], "ag-sort"]]) {
      const color = () => find(view.render(cx), id).style.text_color;
      assert.equal(color(), rest, `${id} at rest`);
      fire(find(view.render(cx), id), "on_hover", true, cx);
      assert.equal(color(), bright, `${id} hovered`);
      fire(find(view.render(cx), id), "on_hover", false, cx);
      assert.equal(color(), rest, `${id} left`);
    }
    const pane = () => find(views[3].render(cx), "ph-x-p0");
    fire(pane(), "on_hover", true, cx);
    assert.equal(pane().style.text_color, bright, "a pane button too");
    fire(pane(), "on_hover", false, cx);
    const toggle = () => find(views[0].render(cx), "sidebar-toggle");
    fire(toggle(), "on_hover", true, cx);
    fire(toggle(), "on_click", {}, cx);
    assert.equal(toggle().style.text_color, rest, "the toggle goes with the sidebar, so it can't wait for the pointer to report leaving");
  }
  {
    // Every control says what it is. A pane's header focuses it; it's no control.
    // As in T3, an icon alone says it on hover too; words may, naming what they do. A row's own fold and the editor's icon picks explain themselves.
    const f = fixture(256);
    const pane = f.load("t3-pane", { pane: "p0" });
    pane.hovered = true;
    const views = [f.load("t3-chrome"), f.load("t3-chrome", { footer: true }), f.load("t3-tabs"), pane, f.load("t3-spaces"), f.load("t3-agents"), f.load("t3-inbox"),
      f.load("t3-tabs", { part: "end" }), f.load("t3-agents", { sortMenu: true }), f.load("t3-new-menu")];
    for (const view of views) for (const n of walk(view.render(cx))) {
      if (n.handlers.on_click && !String(n.key).startsWith("pane-head")) assert.equal(n.style.role, "button", `${n.key}: a role`);
      if (n.style.role !== "button") continue;
      assert.ok(n.style.accessibility_label, `${n.key}: a label`);
      assert.ok(!("tooltip" in n.style), `${n.key}: the shell's tooltip isn't T3's`);
      const tipped = walk(view.render(cx)).some(c => c.kind === "hovercard" && c.items.some(i => i.key === n.key));
      const icon = n.items.length === 1 && n.items[0].kind === "svg", plain = /agent-fold|^(icon|sub|ag|card|slim|close-b|close-o)/.test(n.key);
      if (icon && !plain) assert.ok(tipped, `${n.key}: an icon alone has a hover label`);
    }
  }
  {
    // A mark with no words says what it is on hover; what sits at the window's bottom opens upward, as a HoverCard doesn't flip.
    const f = fixture(256), ag = f.load("t3-agents"), footer = f.load("t3-chrome", { footer: true });
    const mark = () => find(ag.render(cx), "tip-status-t0-mark");
    assert.equal(strings(mark().style.content).length, 0, "its card waits for the hover");
    fire(find(ag.render(cx), "status-t0-mark"), "on_hover", true, cx);
    assert.ok(strings(mark().style.content).length > 0);
    assert.equal(find(ag.render(cx), "status-t0").style.accessibility_label, strings(mark().style.content)[0]);
    fire(find(ag.render(cx), "status-t0-mark"), "on_hover", false, cx);
    assert.equal(strings(mark().style.content).length, 0);
    assert.equal(find(footer.render(cx), "tip-add-machine").style.anchor, "bottom_center");
  }
  {
    // Whatever opens over its button hides the pointer's leaving from it: it doesn't stay lit.
    const f = fixture(256), footer = f.load("t3-chrome", { footer: true }), agents = f.load("t3-agents"), inbox = f.load("t3-inbox");
    for (const [view, id] of [[footer, "settings"], [footer, "add-machine"], [agents, "ag-sort"], [inbox, "inbox-search"], [inbox, "inbox-new-tab"]]) {
      fire(find(view.render(cx), id), "on_hover", true, cx);
      assert.equal(view.hot, id);
      fire(find(view.render(cx), id), "on_click", {}, cx);
      assert.equal(view.hot, null, `${id} doesn't stay lit`);
    }
  }
  {
    // A row's details, as T3's thread card: at the row's top right, with T3's tooltip group for timing and fade.
    const f = fixture(256), inbox = f.load("t3-inbox");
    f.panes()[0].branch = "feat/x";
    f.panes()[1].branch = "main";
    const anchor = (a) => find(inbox.render(cx), `details-${a}`);
    const card = (a) => anchor(a)?.style.content;
    const row = (a) => find(inbox.render(cx), `card-${a}`);
    const hover = (a, on) => fire(row(a), "on_hover", on, cx);
    cx.timers.length = 0; // Other tests' hovers left theirs.
    const due = (ms) => cx.timers.filter(t => t.ms === ms && !t.gone);
    const pass = (ms) => { for (const t of due(ms)) { t.gone = true; t.fn(cx); } };
    assert.equal(anchor("t0"), null, "nothing until hovered");
    hover("t0", true);
    assert.deepEqual([anchor("t0").style.top, anchor("t0").style.right, anchor("t0").style.size], [-1, -1, 1], "its bottom left, where a Popup hangs from, is the row's top right");
    assert.equal(card("t0"), undefined, "the first waits, its anchor already measured");
    assert.equal(due(150).length, 1);
    hover("t0", false);
    assert.equal(due(150).length, 0, "leaving first cancels it");
    assert.equal(anchor("t0"), null);
    hover("t0", true);
    pass(150);
    assert.equal(card("t0").style.opacity, 0, "drawn clear first: a transition adopts the first value it sees");
    assert.ok(card("t0").key && "transition" in card("t0").style, "and it needs an id to sample by");
    pass(34);
    assert.equal(card("t0").style.opacity, 1, "then it fades in");
    assert.equal(card("t0").style.ml, 4);
    assert.ok(row("t0").style.relative !== undefined);
    assert.deepEqual(strings(card("t0")).slice(1), ["P", "project 0", "feat/x", "Pi"], "its mark and project, branch, program; no machine on this one");
    assert.equal(strings(card("t0"))[0], row("t0").style.accessibility_label, "led by the title the row shows");
    // The pointer can report entering the next row before leaving this one.
    hover("vps/t2", true);
    assert.equal(due(150).length, 0, "the next opens at once");
    assert.equal(card("t0"), undefined, "one up at a time");
    assert.equal(card("vps/t2").style.opacity, 1, "unfaded");
    assert.deepEqual(strings(card("vps/t2")).slice(1), ["P", "project 2", "vps", "main", "Pi"], "another machine's names it");
    assert.equal(find(inbox.render(cx), "tip-machine-vps/t2").style.open_delay, 0, "a control's label in the row opens at once too");
    hover("t0", false);
    assert.ok(card("vps/t2"), "the late leave of the row before doesn't close it");
    hover("vps/t2", false);
    assert.equal(card("vps/t2").style.opacity, 0, "the last one fades out");
    assert.equal(due(150).length, 1);
    pass(150);
    assert.equal(anchor("vps/t2"), null, "then it's gone");
    hover("t0", true);
    assert.equal(card("t0").style.opacity, 1, "within 400ms the next still opens at once");
    inbox.hot = "machine-t0";
    assert.equal(card("t0"), undefined, "a lit control's own label speaks instead");
    inbox.hot = null;
    assert.ok(card("t0"), "and it's back with the pointer on the row");
    fire(row("t0"), "on_click", {}, cx);
    assert.equal(card("t0").style.opacity, 0, "a click takes it down");
    pass(150);
    assert.equal(card("t0"), undefined);
    hover("t0", false);
    inbox.detailsClosed = Date.now() - 400;
    assert.equal(find(inbox.render(cx), "tip-machine-vps/t2").style.open_delay, 150, "past 400ms a label waits again");
    hover("t0", true);
    assert.equal(card("t0"), undefined, "and so does the card");
    pass(150);
    assert.equal(card("t0").style.opacity, 0);
    hover("t0", false);
    hover("t0", true);
    assert.equal(card("t0").style.opacity, 1, "coming back while it fades out lifts it again");
  }
  {
    // A hover label, as T3's: the label with its bound key, a dim hint, and nothing up unless the button is lit.
    const f = fixture(256), tabs = f.load("t3-tabs", { part: "end" }), inbox = f.load("t3-inbox");
    f.spaces()[0].active = true;
    const card = (view, id) => find(view.render(cx), `tip-${id}`).style.content;
    assert.deepEqual(strings(card(tabs, "tab-new")), [], "not while unlit");
    fire(find(tabs.render(cx), "tab-new"), "on_hover", true, cx);
    assert.deepEqual(strings(card(tabs, "tab-new")), ["New tab (⌘T)"]);
    assert.equal(card(tabs, "tab-new").style.text_size, 12);
    fire(find(tabs.render(cx), "tab-new"), "on_click", {}, cx);
    fire(find(inbox.render(cx), "inbox-new-tab"), "on_hover", true, cx);
    assert.deepEqual(strings(card(inbox, "inbox-new-tab")), ["New tab"], "a label names its control; what opens says the rest");
    fire(find(inbox.render(cx), "inbox-new-tab"), "on_click", {}, cx);
    assert.deepEqual(strings(card(inbox, "inbox-new-tab")), [], "what opens over it takes its label down");
    inbox.hot = "inbox-scope";
    assert.deepEqual(strings(card(inbox, "inbox-scope")), ["Filter by space", "Shift+click to pick several"], "a second line only for what can't be seen");
    // A program's icon has no label of its own, as T3's rows.
    f.panes()[0].program = f.agents()[0].program;
    for (const [name, view] of Object.entries({ tabs: f.load("t3-tabs"), inbox, agents: f.load("t3-agents"), pane: f.load("t3-pane", { pane: "p0" }) })) {
      const nodes = walk(view.render(cx));
      assert.ok(nodes.some(n => n.source === "icons/pi.svg"), `${name}: the icon is there`);
      // A label whose trigger is the icon alone; a tab's, with its name, is the tab's.
      assert.ok(!nodes.some(n => String(n.key).startsWith("tip-") && strings(n.items[0]).length === 0 && walk(n).some(c => c.source === "icons/pi.svg")), `${name}: no label on a program's icon`);
    }
  }
  {
    // A tab as T3's panel tab: 24px, 12px; its icon's slot closes it, a × while the tab is hovered.
    // A tab drags as a space does, and leaving ends either.
    const f = fixture(256), tabs = f.load("t3-tabs"), spaces = f.load("t3-spaces");
    f.spaces()[0].active = f.spaces()[0].tabs[0].active = true;
    f.spaces()[0].tabs.push({ id: "other", index: 2, name: "other", named: true });
    const tab = find(tabs.render(cx), "tab-other").style;
    assert.deepEqual([tab.h, tab.text_size, tab.pl, tab.gap], [24, 12, 6, 2]);
    const close = () => find(tabs.render(cx), "close-other");
    assert.deepEqual([close().style.size, close().style.accessibility_label], [16, "Close other"], "every tab has it, not only the active one");
    assert.equal(close().items[0].source, "mods/workspace-chrome/terminal.svg", "at rest it's the tab's icon, a terminal's when it has no program");
    fire(find(tabs.render(cx), "tab-other"), "on_hover", true, cx);
    assert.equal(close().items[0].source, "mods/pane/close.svg", "hovered, a ×");
    assert.equal(find(tabs.render(cx), "tab-other").style.text_color, f.theme().foreground);
    // Its whole name and nothing else, with an Inbox row's timing: after 150ms for the first and at once for the next.
    const tabCard = (id) => find(tabs.render(cx), `details-${id}`)?.style.content;
    assert.equal(tabCard("other"), undefined, "the first waits");
    cx.timers.filter(t => t.ms === 150 && !t.gone).forEach(t => { t.gone = true; t.fn(cx); });
    assert.equal(tabCard("other").style.opacity, 0, "drawn clear first");
    cx.timers.filter(t => t.ms === 34 && !t.gone).forEach(t => { t.gone = true; t.fn(cx); });
    assert.equal(tabCard("other").style.opacity, 1, "then it fades in");
    assert.equal(tabCard("other").style.mt, 4);
    assert.deepEqual(strings(tabCard("other")), ["other"], "only its whole name: the project and branch are in the sidebar");
    assert.deepEqual([find(tabs.render(cx), "details-other").style.bottom, find(tabs.render(cx), "details-other").style.left, find(tabs.render(cx), "details-other").style.size], [0, 15, 1], "a Popup hangs from the tab's bottom, its words under the tab's name");
    fire(find(tabs.render(cx), "tab-b0"), "on_hover", true, cx);
    assert.equal(tabCard("b0").style.opacity, 1, "the next tab's opens at once");
    fire(find(tabs.render(cx), "tab-b0"), "on_hover", false, cx);
    fire(find(tabs.render(cx), "tab-other"), "on_hover", true, cx);
    fire(find(tabs.render(cx), "tab-other"), "on_mouse_down:left", { click_count: 1 }, cx);
    assert.equal(tabCard("other"), undefined, "a press puts it away");
    fire(find(tabs.render(cx), "tab-other"), "on_mouse_up:left", {}, cx);
    f.calls.pop();
    assert.ok(find(tabs.render(cx), "tab-other").items.some(n => "truncate" in n.style && n.style.min_w === 0), "the name truncates in the tab itself");
    fire(find(tabs.render(cx), "tab-other"), "on_hover", false, cx);
    assert.equal(close().items[0].source, "mods/workspace-chrome/terminal.svg");
    fire(close(), "on_click", {}, cx);
    assert.deepEqual(f.calls.pop(), ["t3-tabs.close-tab:other", {}], "the × goes through the tab bar's answer");
    cx.timers.filter(t => t.ms === 150 && !t.gone).forEach(t => { t.gone = true; t.fn(cx); });
    assert.equal(find(tabs.render(cx), "details-other"), null, "not when the pointer is away, once it has faded");
    fire(find(tabs.render(cx), "tab-b0"), "on_mouse_down:left", { click_count: 1 }, cx);
    fire(find(tabs.render(cx), "tab-other"), "on_mouse_move", {}, cx);
    assert.equal(find(tabs.render(cx), "tab-b0").style.opacity, 0.5, "the dragged tab fades");
    assert.ok(walk(find(tabs.render(cx), "tab-other")).some(n => "absolute" in n.style && n.style.w === 2), "a line shows where it lands");
    fire(tabs.render(cx), "on_hover", false, cx);
    assert.equal(tabs.pressed, null, "leaving the bar ends the drag");
    assert.equal(find(tabs.render(cx), "tab-b0").style.opacity, undefined);
    const id = `space-${f.spaces()[0].id}`;
    fire(find(spaces.render(cx), id), "on_mouse_down:left", {}, cx);
    fire(find(spaces.render(cx), "space-list"), "on_hover", false, cx);
    assert.equal(spaces.pressed, null, "leaving the list ends a space's drag");
  }
  {
    // A person's close asks when it ends terminals, as T3's; only the dialog's command closes.
    const f = fixture(256), jobs = [], spawn = cx.spawn;
    f.spaces().splice(0, Infinity,
      { id: "s", active: true, tabs: [{ id: "a", name: "Alpha", named: true, active: true }, { id: "b", name: "Beta", named: true }] },
      { id: "solo", tabs: [{ id: "c", name: "Solo", named: true }] });
    f.panes().splice(0, Infinity, { pane: "p1", tab: "a", terminal: "t1" }, { pane: "p2", tab: "a", terminal: "t2" },
      { pane: "m", tab: "b", mod: "board" }, { pane: "p4", tab: "c", terminal: "t4" });
    Object.assign(f.shown, { tab: "a", pane: "p1" });
    cx.spawn = fn => jobs.push(fn);
    const view = f.load("t3-tabs");
    f.load("t3-tabs", { part: "end", block: "tabs-end" });
    f.load("t3-tabs", { part: "measure" });
    cx.spawn = spawn;
    assert.equal(jobs.length, 1, "of the layout's three copies only the tab strip answers, or one close opens three dialogs");
    const say = async command => { f.commands.push(command); jobs[0](cx); await new Promise(resolve => setImmediate(resolve)); };
    // What `hc get` says: its own shell at the prompt, a program it started, a program that is the terminal, or no answer.
    const shell = { pid: 1, foreground: { pid: 1, name: "zsh" } }, program = { pid: 1, foreground: { pid: 2, name: "sleep" } }, own = { pid: 1, foreground: { pid: 1, name: "sleep" } };
    let fg = () => program;
    f.answerHc(args => ({ code: 0, stdout: JSON.stringify(fg(args[1])) }));
    f.calls.length = 0;
    await say("close-tab");
    let asked = f.overlays.pop();
    assert.deepEqual([asked.mod, asked.props.title], ["confirm", 'Close tab "Alpha"?'], "the name in the title, as T3's");
    assert.match(asked.props.detail, /^This stops its 2 running processes/);
    assert.doesNotMatch(asked.props.detail, /space closes/);
    assert.deepEqual(plain(asked.props.command), { name: "tab.close", args: { id: "a", confirmed: true } }, "so the space's own ask can't follow");
    await say("close-pane");
    assert.deepEqual(f.closed.length, 1, "a second ask replaces the first");
    asked = f.overlays.pop();
    assert.deepEqual(plain(asked.props.command), { name: "pane.close", args: { pane: "p1" } });
    await say("close-pane:p2");
    assert.deepEqual(plain(f.overlays.pop().props.command.args), { pane: "p2" }, "the pane header's × names its pane");
    assert.deepEqual(f.calls, [], "nothing closes before the answer");
    Object.assign(view, { overTab: "a", details: "a" });
    await say("close-tab");
    f.overlays.pop();
    assert.deepEqual([view.overTab, view.details], [null, null], "cmd-w over a hovered tab takes its card too");
    Object.assign(f.shown, { tab: "c", pane: "p4" });
    await say("close-tab");
    assert.match(f.overlays.pop().props.detail, /its running process.*space closes too/, "the last tab says its space goes too");
    assert.equal(f.overlays.length, 0);
    f.spaces()[1].tabs[0].name = "x".repeat(41);
    await say("close-tab");
    assert.equal(f.overlays.pop().props.title, `Close tab "${"x".repeat(30)}…"?`, "a long name is cut to fit the title, which doesn't wrap");
    f.spaces()[1].tabs[0].name = "feat(herdr-t3): 关闭标签与窗格二次确认";
    await say("close-tab");
    assert.equal(f.overlays.pop().props.title, 'Close tab "feat(herdr-t3): 关闭标签与窗格…"?', "a wide character counts twice");
    Object.assign(f.shown, { tab: "b", pane: "m" });
    await say("close-tab");
    assert.deepEqual(f.calls.pop(), ["tab.close", { id: "b" }], "a tab of mods has no terminal to lose");
    await say("close-pane");
    assert.deepEqual(f.calls.pop(), ["pane.close", { pane: "m" }], "nor has a mod's pane");
    await say("close-pane:p4");
    assert.deepEqual(f.calls.pop(), ["pane.close", { pane: "p4" }], "a space's last pane closes the space, which Herdr asks about itself");
    assert.equal(f.overlays.length, 0);
    // Empty panes have nothing to lose: nothing asks, and the same goes for a tab of them.
    f.calls.length = 0;
    fg = () => shell;
    await say("close-pane:p1");
    assert.deepEqual(f.calls.pop(), ["pane.close", { pane: "p1" }], "a shell at its prompt closes at once");
    await say("close-tab:a");
    assert.deepEqual(f.calls.pop(), ["tab.close", { id: "a" }], "and so does a tab of them");
    assert.equal(f.overlays.length, 0);
    fg = t => t === "t1" ? program : shell;
    await say("close-tab:a");
    assert.match(f.overlays.pop().props.detail, /This stops its running process and/, "only what's running counts");
    fg = () => own;
    await say("close-pane:p1");
    assert.equal(f.overlays.pop().props.command.name, "pane.close", "a program that is the terminal is no prompt");
    fg = () => { throw new Error("no answer"); };
    await say("close-pane:p1");
    assert.equal(f.overlays.pop().props.command.name, "pane.close", "no answer asks");
    Object.assign(f.shown, { tab: undefined, pane: undefined });
    f.calls.length = 0;
    await say("close-tab"); await say("close-pane");
    assert.deepEqual([f.calls, f.overlays.length], [[], 0], "with nothing focused, nothing to close");
  }
  {
    // cmd-] and cmd-[ (t3-chrome.next / .prev): with the Inbox showing, T3's traversal over the rows it draws, from the
    // one in view, stopping at either end; Lists keep Herdr's agent.next.
    const f = fixture(256), jobs = [], spawn = cx.spawn;
    cx.spawn = fn => jobs.push(fn);
    f.load("t3-chrome"); f.load("t3-chrome", { footer: true });
    cx.spawn = spawn;
    assert.equal(jobs.length, 1, "only the brand bar's copy listens");
    f.slots.lists = { id: "sidebar-lists", active: "inbox" };
    const press = async (command, rows) => {
      f.state["t3-inbox.rows"] = rows; f.calls.length = 0; f.commands.push(command);
      jobs[0](cx); await new Promise(resolve => setImmediate(resolve));
      return f.calls.slice();
    };
    const order = ["t0", "vps/t2", "t5"];
    assert.deepEqual(await press("next", { order, view: "vps/t2" }), [["agent.focus", { terminal: "t5" }]]);
    assert.deepEqual(await press("prev", { order, view: "vps/t2" }), [["agent.focus", { terminal: "t0" }]]);
    assert.deepEqual(await press("next", { order, view: "t5" }), [], "at the end it stays, as T3's");
    assert.deepEqual(await press("prev", { order, view: "t0" }), []);
    assert.deepEqual(await press("next", { order, view: null }), [["agent.focus", { terminal: "t0" }]], "none in view: the first");
    assert.deepEqual(await press("prev", { order, view: null }), [["agent.focus", { terminal: "t5" }]], "or the last");
    const mixed = ["t0", "pane:p9", "t5"];
    assert.deepEqual(await press("next", { order: mixed, view: "t0" }), [["pane.focus", { pane: "p9" }]], "a mod pane's row has no agent to focus");
    assert.deepEqual(await press("next", { order: mixed, view: "pane:p9" }), [["agent.focus", { terminal: "t5" }]], "and the walk goes on from it");
    f.slots.lists.active = "lists";
    assert.deepEqual(await press("next", { order, view: "t0" }), [["agent.next", {}]], "Lists keep agent.next");
  }
  {
    // Every menu goes by arrows and Enter, and says when a search finds nothing.
    const f = fixture(256), key = (view, id, k) => fire(find(view.render(cx), id), "on_key_down", { key: k }, cx);
    const sort = f.load("t3-agents", { sortMenu: true });
    assert.equal(find(sort.render(cx), "sort-grouped").style.bg, f.theme().selected, "it opens on the current sort");
    key(sort, "sort-menu", "down");
    assert.equal(find(sort.render(cx), "sort-priority").style.bg, f.theme().selected, "down wraps to the first row");
    key(sort, "sort-menu", "enter");
    assert.equal(f.state["agents.sort"], "priority");
    const inbox = f.load("t3-inbox");
    const panel = () => find(inbox.render(cx), "inbox-scope-menu").style.content;
    fire(find(panel(), "inbox-scope-panel"), "on_key_down", { key: "down" }, cx);
    assert.equal(inbox.scopeAt, 1);
    assert.equal(find(panel(), "scope-all").style.bg, undefined);
    const spaces = f.load("t3-new-menu");
    spaces.filter = "no such space";
    assert.ok(strings(spaces.render(cx)).includes("No matching spaces."));
  }
  console.log("ok: sidebar widths 208/240/256/320/480, pins, tree, colors, space drag, search/settings, tabs and pane controls, inbox Working/Settle.");
})().catch(e => { console.error(e); process.exit(1); });
