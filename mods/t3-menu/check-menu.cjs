const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  const node = { items: [], handlers: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child") node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "on_click") node.handlers.click = args[0];
      else if (key === "on_key_down") node.handlers.key = args[0];
      else if (key === "id") node.key = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const rows = (root) => root.items.filter((n) => !String(n.key).startsWith("menu-sep"));
const text = (row) => row.items[1].items[0];

let calls = [], overlays = [], closed = [], props = {};
const local = { id: "s1", name: "Work", machine: null, tabs: [{ id: "a", name: "1" }, { id: "b", name: "2" }] };
const other = { id: "s2", name: "Docs", machine: null, tabs: [{ id: "c", name: "1" }] };
const remote = { id: "vps/s3", name: "Server", machine: "vps", tabs: [{ id: "vps/d", name: "1" }, { id: "vps/e", name: "2" }] };
let ps = [
  { pane: "p1", terminal: "t1", tab: "a" }, { pane: "p2", terminal: "t2", tab: "a" }, { pane: "p3", terminal: "t3", tab: "b" },
  { pane: "p4", terminal: null, mod: "viewer", tab: "b" }, { pane: "p5", terminal: "t5", tab: "c" },
  { pane: "vps/p6", terminal: "vps/t6", tab: "vps/d" }, { pane: "vps/p7", terminal: "vps/t7", tab: "vps/e" },
];
const terms = [{ address: "t1", name: "lead", labels: {} }, { address: "t2", parent: "t1", labels: {} }, { address: "t3", labels: {} }, { address: "t5", labels: {} }, { address: "vps/t6", labels: {} }, { address: "vps/t7", labels: {} }];
const env = {
  View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
  theme: () => ({}), props: () => props, panes: () => ps, spaces: () => [local, other, remote], terminals: () => terms,
  run: (name, args) => calls.push([name, args ?? null]),
  openOverlay: (o) => { overlays.push(o); return "o2"; }, closeOverlay: (id) => closed.push(id),
};
const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
const context = vm.createContext({ ...env, Math });
vm.runInContext(src, context, { filename: "main.js" });
const menu = new context.Mod();
menu.init({}, { focus_handle: () => ({ focus() {} }) });
const cx = { notify() {}, stop_propagation() {} };

const open = (tab, target) => { props = { tab, target, overlay: "o1" }; return rows(menu.render()); };
const row = (list, label) => list.find((r) => text(r) === label);
const pick = (list, label) => { calls = []; closed = []; row(list, label).handlers.click({}, cx); return JSON.parse(JSON.stringify(calls)); };

// The popup's height is one number: mod.json's. A change to the rows changes it.
const pane1 = open("pane", { pane: "p1", terminal: "t1" });
const all = menu.render().items, h = all.reduce((sum, n) => sum + (String(n.key).startsWith("menu-sep") ? 9 : 30), 10);
assert.equal(h, JSON.parse(fs.readFileSync(path.join(__dirname, "mod.json"), "utf8")).overlay.height);

// New space: fresh ids, the view moved by t3-tabs, the popup closed first.
let c = pick(pane1, "Move to new space");
assert.match(c[0][0], /^t3-tabs\.move:t1 sp[0-9a-f]{32} tb[0-9a-f]{32}$/);
assert.deepEqual(closed, ["o1"]);
// New tab: this space.
c = pick(pane1, "Move to new tab");
assert.match(c[0][0], /^t3-tabs\.move:t1 s1 tb[0-9a-f]{32}$/);
// On another machine, the new ids are that machine's.
c = pick(open("pane", { pane: "vps/p6", terminal: "vps/t6" }), "Move to new space");
assert.match(c[0][0], /^t3-tabs\.move:vps\/t6 vps\/sp[0-9a-f]{32} vps\/tb[0-9a-f]{32}$/);

// Nothing to leave: a space's or a tab's only pane.
let list = open("pane", { pane: "p5", terminal: "t5" });
assert.deepEqual(pick(list, "Move to new space"), [], "alone in its space");
assert.deepEqual(pick(list, "Move to new tab"), [], "alone in its tab");
assert.deepEqual(pick(list, "Close other panes"), []);
list = open("pane", { pane: "p3", terminal: "t3" });
assert.equal(pick(list, "Move to new space").length, 1, "its space has others");
assert.deepEqual(pick(list, "Move to new tab").length, 1, "the viewer beside it is a pane too");

// A mod pane has no terminal to move, but splits, zooms and closes.
list = open("pane", { pane: "p4", terminal: null });
for (const label of ["Move to new space", "Move to new tab", "Move to...", "Send right-clicks to pane"]) assert.deepEqual(pick(list, label), [], label);
assert.deepEqual(pick(list, "Split right"), [["pane.split", { direction: "right", pane: "p4" }]]);
assert.deepEqual(pick(list, "Close pane"), [["t3-tabs.close-pane:p4", null]], "the tab bar asks first");

// Send back only with a parent.
assert.deepEqual(pick(open("pane", { pane: "p2", terminal: "t2" }), "Send back to lead"), [["terminal.park", { terminal: "t2" }]]);
assert.deepEqual(pick(pane1, "Send back to parent"), []);
assert.deepEqual(pick(pane1, "Close other panes"), [["t3-tabs.close-others:p1", null]]);

// Move to...: every other tab here, never another machine's, sized to what's listed.
list = open("pane", { pane: "p1", terminal: "t1" });
overlays = []; pick(list, "Move to...");
assert.equal(overlays[0].mod, "t3-menu");
assert.equal(overlays[0].height, 70);
assert.deepEqual(JSON.parse(JSON.stringify(overlays[0].props)), { tab: "move", target: { pane: "p1" } });
list = open("move", { pane: "p1" });
assert.deepEqual(list.map(text), ["Work · 2", "Docs"]);
assert.deepEqual(pick(list, "Docs"), [["t3-tabs.move:t1 s2 c", null]]);
list = open("move", { pane: "vps/p6" });
assert.deepEqual(list.map(text), ["Server · 2"]);
assert.deepEqual(pick(list, "Server · 2"), [["t3-tabs.move:vps/t6 vps/s3 vps/e", null]]);

// A tab's menu.
list = open("tab", { id: "a", space: "s1" });
assert.deepEqual(list.map(text), ["Rename", "New tab", "Close"]);
assert.deepEqual(pick(list, "Close"), [["t3-tabs.close-tab:a", null]]);

// The keys skip greyed rows.
props = { tab: "pane", target: { pane: "p5", terminal: "t5" }, overlay: "o1" };
menu.at = -1;
const key = (k) => menu.render().handlers.key({ key: k }, cx);
key("down"); key("down"); key("down"); key("down");
overlays = []; key("enter");
assert.equal(overlays[0]?.props?.tab, "move", "Split right, Split down, Zoom, then Move to...: both new-place rows are grey here");
console.log("ok: pane and tab menus; moves use fresh ids on the pane's own machine; rows that can't apply are grey and do nothing; Move to... lists only this machine's other tabs.");
