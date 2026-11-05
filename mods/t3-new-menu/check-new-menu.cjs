// Loads the menu in a fake `herdr`: the order, the keys' scrolling, and where a new space goes.
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
      else if (key === "on_click") node.handlers.click = args[0];
      else if (key === "on_key_down") node.handlers.key = args[0];
      else if (key === "on_item_click") node.handlers.item = args[0];
      else if (key === "id") node.key = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const find = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const child of node.items) { const found = find(child, id); if (found) return found; }
  return null;
};

let spaces, machines;
const calls = [], scrolled = [];
const cx = { notify() {}, stop_propagation() {} };
const context = vm.createContext({
  View: class {}, div: element, svg: element, h_flex: element, v_flex: element, Input: { new: element },
  InputState: { new: () => { const on = {}; let value = ""; return { on: (e, f) => { on[e] = f; }, value: () => value, focus() {}, set_value(v) { value = v; }, type(v) { value = v; on.change({}, cx); } }; } },
  VirtualListScrollHandle: { new: () => ({ scroll_to_item: (i) => scrolled.push(i) }) },
  v_virtual_list: (id, n, size, key, render) => { const list = element(); list.key = id; list.count = n; list.keys = Array.from({ length: n }, (_, i) => key(i)); list.drawn = render({ start: 0, end: n }); return list; },
  theme: () => ({ foreground: "#fff" }), spaces: () => spaces, machines: () => machines, panes: () => [], run: (name, args) => calls.push([name, args]),
  closeOverlay() {}, props: () => ({ overlay: "o" }), window: () => ({ platform: "macos" }), keys: () => [], home: () => "/home/me", projectMark: element,
});
const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
vm.runInContext(src, context);
const open = () => { const m = new context.Mod(); m.init(); return m; };
const list = (m) => find(m.render(), "new-rows");
const press = (m, key, platform = false) => m.render().handlers.key({ key, modifiers: { platform } }, cx);
const take = () => JSON.parse(JSON.stringify(calls.splice(0)));

const local = (id, active = false) => ({ id, name: id, folder: "/home/me/" + id, machine: null, active });
const remote = (id, active = false) => ({ id, name: id, folder: "", machine: "kvm", active });
machines = [{ name: null, layout: "ready" }, { name: "kvm", layout: "ready" }, { name: "away", layout: "unavailable" }];

// The current space leads, a machine's spaces stay together, ⌘n follows what's shown.
spaces = [remote("r1"), local("a"), remote("r2", true), local("b")];
let m = open();
assert.deepEqual([...list(m).keys], ["space:r2", "space:r1", "space:a", "space:b"]);
press(m, "3", true);
assert.deepEqual(take(), [["tab.new", { space: "a" }]]);

// Up and down keep the highlighted row on screen, round the ends too.
spaces = [local("a", true), remote("r1"), local("b")];
m = open();
press(m, "up");
press(m, "down");
press(m, "down");
assert.deepEqual(scrolled.splice(0), [2, 0, 1]);
m.spaceInput.type("kvm");
assert.deepEqual([...list(m).keys], ["space:r1"], "search finds a space by its machine");
assert.equal(scrolled.pop(), 0);
m.spaceInput.type("nothing");
assert.equal(list(m), null);
press(m, "down"); // no rows: nothing to reach, nothing thrown
list(open()).handlers.item("space:r1", cx);
assert.deepEqual(take(), [["tab.new", { space: "r1" }]]);

// New space asks which machine; one that's away can't be picked.
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
assert.deepEqual(take(), []);
assert.deepEqual([...list(m).keys], ["machine:", "machine:away", "machine:kvm"]);
list(m).handlers.item("machine:away", cx);
assert.deepEqual(take(), []);
list(m).handlers.item("machine:kvm", cx);
assert.deepEqual(take(), [["space.new", { machine: "kvm" }]]);
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
find(m.render(), "new-back").handlers.click({}, cx);
assert.deepEqual([...list(m).keys], ["space:a", "space:b", "space:r1"], "Back returns to the spaces");
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
list(m).handlers.item("machine:", cx);
assert.deepEqual(take(), [["space.new", { machine: "" }]], "This computer");

// On a remote space its machine is offered first; with one machine there is nothing to ask.
spaces = [local("a"), remote("r1", true)];
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
assert.equal(list(m).keys[0], "machine:kvm");
machines = [{ name: null, layout: "ready" }];
spaces = [local("a", true)];
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
assert.deepEqual(take(), [["space.new", { machine: "" }]]);
console.log("ok new menu");
