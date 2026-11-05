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
      else if (key === "child" || key === "trigger") node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "on_click") node.handlers.click = args[0];
      else if (key === "on_mouse_down") node.handlers[args[0]] = args[1];
      else if (key === "id") node.key = args[0];
      return proxy;
    };
  } });
  return proxy;
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const child of node.items) { const found = find(child, id); if (found) return found; }
  return null;
}

function texts(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const child of node.items) texts(child, out);
  return out;
}

const calls = [], images = [];
const program = { name: "Pi", key: "pi", agent: true };
const pane = { pane: "p2", terminal: "t2", tab: "b", title: "pi", cwd: "/home/me/project", program, status: "working" };
const review = { pane: "p4", terminal: null, mod: "review-pane", tab: "b", title: "review-pane", cwd: null };
let sharedValues = {};
const shell = { pane: "p3", terminal: "t3", tab: "b", title: "me@mac: ~/project", cwd: "/home/me/project", program: { name: "zsh", key: "shell", shell: true }, status: null };
let terms = [{ address: "t2", labels: {} }, { address: "t3", labels: {} }];
let tab = { id: "b", name: "Release", named: true };
let sidebar = { id: "root", children: [{ id: "sidebar-lists", active: "lists" }] };
let props = { pane: "p2" };
const env = {
  View: class {}, div: element, svg: element, image: (src) => { images.push(src); return element(); }, h_flex: element, v_flex: element, HoverCard: { new: element }, keys: () => [],
  theme: () => ({}), props: () => props, panes: () => [pane, shell, review], shared: (k) => sharedValues[k] ?? null, home: () => "/home/me",
  terminals: () => terms, agents: () => [], spaces: () => [{ tabs: [tab] }], layout: () => sidebar,
  run: (name, args) => calls.push([name, args]),
};
const cx = { notify() {}, stop_propagation() {} };
// name.js, tree.js and tip.js are inlined as the mod's own copies are.
function load(...files) {
  const src = files.map((f) => fs.readFileSync(f, "utf8")).join("\n")
    .replace(/^import .*;\r?\n/gm, "").replace(/export (function|const) /g, "$1 ").replace("export default class", "globalThis.Mod = class");
  const context = vm.createContext({ ...env });
  vm.runInContext(src, context, { filename: files.at(-1) });
  const mod = new context.Mod(); mod.init(); return mod;
}
const take = () => JSON.parse(JSON.stringify(calls.splice(0)));
const header = load(path.join(__dirname, "name.js"), path.join(__dirname, "tree.js"), path.join(__dirname, "tip.js"), path.join(__dirname, "main.js"));
header.hovered = true;
find(header.render(), "pane-head-p2").handlers.click({}, cx);
assert.deepEqual(take(), [["pane.focus", { pane: "p2" }]]);
find(header.render(), "ph-r-p2").handlers.click({}, cx);
assert.deepEqual(take(), [["pane.split", { direction: "right", pane: "p2" }]]);
find(header.render(), "ph-d-p2").handlers.click({}, cx);
assert.deepEqual(take(), [["pane.split", { direction: "down", pane: "p2" }]]);
find(header.render(), "ph-z-p2").handlers.click({}, cx);
assert.deepEqual(take(), [["pane.zoom", { pane: "p2" }]]);
header.hot = "ph-x-p2";
find(header.render(), "ph-x-p2").handlers.click({}, cx);
assert.equal(header.hot, null, "the dialog hides the pointer's leaving, so its label goes with the click");
assert.deepEqual(take(), [["t3-tabs.close-pane:p2", null]], "the tab bar asks first");

// Names: Pi session, else (agents only) a named tab, else a telling title, else the program.
// The terminal's address leads, then its name.
assert.equal(texts(header.render())[0], "t2");
const named = () => texts(header.render())[1];
terms[0].labels["pi.session"] = "Fix login";
assert.equal(named(), "Fix login");
delete terms[0].labels["pi.session"];
assert.equal(named(), "Release");
tab.named = false; pane.title = "π - Review PR - project";
assert.equal(named(), "Review PR");
pane.title = "π - project";
assert.equal(named(), "Pi", "Pi's unnamed title is only its folder, which the space already says");
pane.title = "⠋ project";
assert.equal(named(), "Pi", "nor Codex's: its spinner and project");
pane.title = "OC | Review PR";
assert.equal(named(), "OC | Review PR", "an agent's marks come off only its own titles");
pane.program = { name: "OpenCode", key: "opencode", agent: true };
assert.equal(named(), "Review PR");
pane.program = program;
pane.title = "✳ Review PR";
assert.equal(named(), "Review PR");
pane.title = "pi";
assert.equal(named(), "Pi");
tab.named = true; props = { pane: "p3" };
assert.equal(named(), "zsh");
shell.title = "t3";
assert.equal(named(), "zsh");
// A mod pane: the title its mod gives itself, else its folder name.
props = { pane: "p4" };
assert.equal(texts(header.render())[0], "review-pane");
sharedValues["review-pane.titles"] = { a: "review · other", b: "review · fix" };
assert.equal(texts(header.render())[0], "review · fix");
// Its icon, the one its mod gives.
sharedValues["review-pane.program"] = { icon: "mods/review-pane/logo.svg", tint: false };
images.length = 0; header.render();
assert.deepEqual(images, ["mods/review-pane/logo.svg"]);
// Its status, the word its mod gives for its tab, with an agent's marks; another tab's isn't its own.
const bare = header.render().items.length;
sharedValues["review-pane.status"] = { a: "working" };
assert.equal(header.render().items.length, bare);
for (const word of ["working", "blocked", "done"]) {
  sharedValues["review-pane.status"] = { b: word };
  assert.equal(header.render().items.length, bare + 1, word);
}
delete sharedValues["review-pane.status"];

// A settled agent's done dot goes only while the inbox shows.
props = { pane: "p2" }; pane.status = "done"; header.hovered = false;
const dots = () => header.render().items.length;
const shown = dots();
terms[0].labels.settled = "1:1";
assert.equal(dots(), shown);
sidebar.children[0].active = "inbox";
assert.equal(dots(), shown - 1);
delete terms[0].labels.settled; terms[0].labels.snoozed = String(Date.now() + 60000);
assert.equal(dots(), shown - 1, "snoozed too");
terms[0].labels.snoozed = String(Date.now() - 1);
assert.equal(dots(), shown, "woken, it is news again");

props = { pane: "missing" };
assert.equal(find(header.render(), "pane-head-p2"), null);
console.log("ok: a lone pane keeps zoom and close; focus, both splits and close target their own pane; names follow the shared rule, a mod pane's its own title and icon; a settled done dot hides under Inbox; a missing pane renders nothing.");
