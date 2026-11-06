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
const pending = [], store = {};
const cx = { notify() {}, stop_propagation() {}, spawn: (f) => { pending.push(f(cx)); } };
const settle = async () => { while (pending.length) await pending.shift(); };
// Folders on each machine: kvm's home is /home/kvm, this computer's /home/me.
const disk = { "/home/kvm": ["code", "notes", ".cache", "a.txt"], "/home/kvm/code": ["shop", "api"], "/home/me": ["work"] };
const norm = (p) => { const out = []; for (const x of p.split("/")) { if (!x || x === ".") continue; if (x === "..") out.pop(); else out.push(x); } return "/" + out.join("/"); };
const context = vm.createContext({
  View: class {}, div: element, svg: element, h_flex: element, v_flex: element, Input: { new: element },
  InputState: { new: () => { const on = {}; let value = ""; return { on: (e, f) => { on[e] = f; }, value: () => value, focus() {}, set_value(v) { value = v; }, type(v) { value = v; on.change({}, cx); } }; } },
  VirtualListScrollHandle: { new: () => ({ scroll_to_item: (i) => scrolled.push(i) }) },
  v_virtual_list: (id, n, size, key, render) => { const list = element(); list.key = id; list.count = n; list.keys = Array.from({ length: n }, (_, i) => key(i)); list.drawn = render({ start: 0, end: n }); return list; },
  theme: () => ({ foreground: "#fff" }), spaces: () => spaces, machines: () => machines, panes: () => [], run: (name, args) => calls.push([name, args]),
  closeOverlay() {}, props: () => ({ overlay: "o" }), window: () => ({ platform: "macos" }), keys: () => [], home: () => "/home/me", projectMark: element,
  exec: async (_cmd, _args, o) => ({ code: 0, stdout: o?.on ? `/home/${o.on}` : "" }), ps: async () => ({ stdout: "" }), pickFolder: async () => null,
  list: async (dir) => { if (!disk[dir]) throw new Error("No such folder"); return disk[dir].map((name) => ({ name, dir: !name.includes(".") || name === ".cache" })); },
  fold: (x) => String(x).normalize("NFC").toLowerCase(), resolve: (t, c) => norm(t.startsWith("/") ? t : `${c.cwd}/${t}`),
  slashes: (x) => x, native: (x) => x,
  shared: (k) => store[k] ?? null, setShared: (k, v) => { store[k] = v; },
});
const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
vm.runInContext(src, context);
const open = () => { const m = new context.Mod(); m.init(undefined, cx); return m; };
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

(async () => {
// New space asks which machine; one that's away can't be picked.
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
assert.deepEqual(take(), []);
assert.deepEqual([...list(m).keys], ["machine:", "machine:away", "machine:kvm"]);
list(m).handlers.item("machine:away", cx);
assert.equal(m.mode, "machines");

// Then the folder on it: its home's folders, dot folders hidden, files left out.
list(m).handlers.item("machine:kvm", cx);
await settle();
assert.equal(m.folderInput.value(), "/home/kvm/");
assert.deepEqual([...list(m).keys], ["here", "dir:code", "dir:notes"]);
list(m).handlers.item("dir:code", cx);
await settle();
assert.equal(m.folderInput.value(), "/home/kvm/code/");
assert.deepEqual([...list(m).keys], ["here", "dir:api", "dir:shop"]);
// Typed: the folder up to the last /, then names that start with the rest first.
m.folderInput.type("/home/kvm/code/sh");
await settle();
assert.deepEqual([...list(m).keys], ["here", "dir:shop"]);
press(m, "tab");
await settle();
assert.equal(m.folderInput.value(), "/home/kvm/code/shop/");
m.folderInput.type("/home/kvm/.");
await settle();
assert.deepEqual([...list(m).keys], ["here", "dir:.cache"], "a dot shows dot folders");
m.folderInput.type("/home/kvm/code/../code/");
await settle();
list(m).handlers.item("here", cx);
assert.deepEqual(take(), [["space.new", { machine: "kvm", folder: "/home/kvm/code" }]]);
// A folder that isn't there still offers its own path, and says why it lists nothing.
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
list(m).handlers.item("machine:kvm", cx);
await settle();
m.folderInput.type("/nowhere/");
await settle();
assert.deepEqual([...list(m).keys], ["here"]);
assert.equal(m.where.err, "No such folder");

m = open();
find(m.render(), "space-new").handlers.click({}, cx);
find(m.render(), "new-back").handlers.click({}, cx);
assert.deepEqual([...list(m).keys], ["space:a", "space:b", "space:r1"], "Back returns to the spaces");
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
list(m).handlers.item("machine:", cx);
await settle();
assert.ok(find(m.render(), "new-browse"), "this computer offers its folder picker");
list(m).handlers.item("here", cx);
assert.deepEqual(take(), [["space.new", { machine: "", folder: "/home/me" }]], "This computer");

// On a remote space its machine is offered first; with one machine it goes straight to the folder.
spaces = [local("a"), remote("r1", true)];
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
assert.equal(list(m).keys[0], "machine:kvm");
machines = [{ name: null, layout: "ready" }];
spaces = [local("a", true)];
m = open();
find(m.render(), "space-new").handlers.click({}, cx);
await settle();
assert.equal(m.mode, "folder");
assert.deepEqual([...list(m).keys], ["here", "dir:work"]);
// A sidebar button names the machine: the menu opens on its folders.
machines = [{ name: null, layout: "ready" }, { name: "kvm", layout: "ready" }];
store["t3-new-menu.start"] = { machine: "kvm", at: Date.now() };
m = open();
await settle();
assert.equal(m.mode, "folder");
assert.equal(m.folderInput.value(), "/home/kvm/");
assert.equal(store["t3-new-menu.start"], null, "used once");
store["t3-new-menu.start"] = { at: Date.now() };
assert.equal(open().mode, "machines");
store["t3-new-menu.start"] = { machine: "kvm", at: Date.now() - 60000 };
assert.equal(open().mode, "spaces", "an old one is ignored");
console.log("ok new menu");
})().catch((e) => { console.error(e); process.exit(1); });
