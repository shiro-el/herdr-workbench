const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function element() {
  const node = { key: null, items: [], handlers: {}, style: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (["child", "content", "trigger"].includes(key)) node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "id") node.key = args[0];
      else if (key === "on_mouse_down" || key === "on_mouse_up") node.handlers[`${key}:${args[0]}`] = args[1];
      else if (key === "on_action") node.handlers[`on_action:${args[0]}`] = args[1];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else node.style[key] = args;
      return proxy;
    };
  } });
  return proxy;
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const child of node.items) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

function slims(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.key?.startsWith("slim-") && !node.key.startsWith("slim-corner-") && !node.key.startsWith("slim-mark-") && !node.key.startsWith("slim-space-")) out.push(node.key.slice(5));
  else for (const child of node.items) slims(child, out);
  return out;
}

function cards(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.key?.startsWith("card-")) out.push(node.key.slice(5));
  else for (const child of node.items) cards(child, out);
  return out;
}

function texts(node) {
  if (typeof node === "string") return [node];
  return node && typeof node === "object" ? node.items.flatMap(texts) : [];
}

// The element whose own child is this text: a card's title, or its branch line.
function holding(node, text) {
  if (!node || typeof node !== "object") return null;
  if (node.items.includes(text)) return node;
  for (const child of node.items) { const hit = holding(child, text); if (hit) return hit; }
  return null;
}

// The row that element sits in.
function lineOf(node, text) {
  if (!node || typeof node !== "object") return null;
  if (node.items.some((child) => child?.items?.includes(text))) return node;
  for (const child of node.items) { const hit = lineOf(child, text); if (hit) return hit; }
  return null;
}

function fixture() {
  const f = { now: 1000, rows: [], terms: [], order: [], calls: [], jobs: [], timers: [], data: new Map(), pins: [], mode: "inbox", notifications: [], state: {}, labelled: [] };
  // The real Date, with its clock at f.now.
  const FakeDate = function (...args) { return args.length ? new Date(...args) : new Date(f.now); };
  FakeDate.now = () => f.now;
  const cx = {
    notify() { f.notified = true; }, stop_propagation() {}, bind_keys(b) { f.bound = b; },
    focus_handle: () => ({ focus() { f.keys = true; } }),
    spawn: (fn) => f.jobs.push(fn),
    timer: {
      every: () => ({}),
      after(ms, fn) {
        const timer = { at: f.now + ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
        f.timers.push(timer);
        return timer;
      },
    },
  };
  const env = {
    View: class {}, div: element, image: (src) => { const e = element(); e.style.image = [src]; return e; }, svg: element, v_flex: element, h_flex: element,
    Popover: { new: (id) => element().id(id) }, HoverCard: { new: (id) => element().id(id) }, Popup: { new: element }, Input: { new: element }, Button: { new: element },
    InputState: { new: (o = {}) => {
      let value = o.value ?? "";
      return { on() {}, value: () => value, set_value(v) { value = v; }, focus() {} };
    } },
    namer: () => (a) => a.mod ? f.state[`${a.mod}.titles`]?.[a.tab] || a.title : a.address, Date: FakeDate,
    programOf: (x) => x.mod ? f.state[`${x.mod}.program`] ?? null : x.program,
    modStatus: (x) => f.state[`${x.mod}.status`]?.[x.tab] ?? null,
    localStorage: { getItem: (k) => f.data.get(k) ?? null, setItem: (k, v) => f.data.set(k, v) },
    keys: () => [], agents: () => f.rows, terminals: () => f.terms, panes: () => [],
    spaces: () => [{ id: "s1", name: "One", tabs: [] }, { id: "s2", name: "Two", tabs: [] }],
    focused: () => ({ agent: f.rows.find((a) => a.focused)?.address }),
    theme: () => ({}), settings: () => ({}), props: () => ({}),
    layout: () => ({ id: "sidebar-lists", active: f.mode }),
    shared: (k) => k === "agents.pins" ? f.pins : f.state[k] ?? null,
    setShared: (k, v) => { if (k === "agents.pins") f.pins = Array.from(v); else f.state[k] = v; },
    setAgentOrder: (xs) => { f.order = Array.from(xs); },
    run: (...args) => f.calls.push(args), notify: (n) => f.notifications.push(n), openOverlay() {}, closeOverlay() {},
    hc: async (args) => { f.labelled.push(args.join(" ")); return { code: 0 }; }, nextCommand: () => new Promise(() => {}),
  };
  // tree.js, project.js, tip.js and details.js, the shared status, space-mark, hover-label and details rules, are inlined as each mod's own copies are.
  const tree = ["tree.js", "project.js", "tip.js", "details.js"].map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n")
    .replace(/^import .*;\r?\n/gm, "").replace(/export (function|const) /g, "$1 ");
  const src = tree + fs.readFileSync(path.join(__dirname, "main.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
  const context = vm.createContext(env);
  vm.runInContext(src, context, { filename: "t3-inbox/main.js" });
  f.context = context;
  f.mod = new context.Mod(); f.mod.init({}, cx);
  f.loadAgents = () => {
    const src = tree + fs.readFileSync(path.join(__dirname, "../t3-agents/main.js"), "utf8")
      .replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
    const context = vm.createContext({ ...env });
    vm.runInContext(src, context);
    const mod = new context.Mod(); mod.init({});
    return () => mod.render(cx);
  };
  f.add = (address, status = "idle", ms = 100) => {
    const row = { address, status, seq: f.rows.length + 1, space: "s1", space_name: "One", pane: address, program: {}, focused: false };
    f.rows.push(row);
    f.terms.push({ address, status, status_ms: ms, state: "live", turn: 0, labels: {} });
    return row;
  };
  f.render = (now = f.now) => {
    f.now = now;
    for (const timer of f.timers) if (!timer.cancelled && timer.at <= now) { timer.cancel(); timer.fn(cx); }
    f.tree = f.mod.render(cx);
    return f.tree;
  };
  f.working = () => cards(find(f.tree, "shelves"));
  f.active = () => cards(find(f.tree, "inbox-list")).filter((a) => !f.working().includes(a) && !f.pins.includes(a));
  f.event = (id, name, e = {}) => {
    const node = find(f.tree, id);
    assert.ok(node, `missing ${id}`);
    assert.ok(node.handlers[name], `missing ${name} on ${id}`);
    node.handlers[name]({ position: { x: 20, y: 100 }, local_position: { x: 20, y: 100 }, bounds: { height: 82 }, modifiers: {}, ...e }, cx);
  };
  f.settle = () => f.mod.settleKey(cx);
  f.napping = () => slims(find(f.tree, "snoozed"));
  // Label writes run as jobs; the core's copy is what the next render reads.
  f.flush = () => { for (const job of f.jobs.splice(0)) job(cx); };
  f.label = (address, key, value) => { f.terms.find((k) => k.address === address).labels[key] = value; };
  f.cx = cx;
  f.env = env;
  // A review in a tab of its own, and the tabs it shares its space with.
  f.review = (pane = "pm", tab = "tr", space = "s1") => {
    f.state["review.program"] = { icon: "mods/review/logo.svg", tint: false, name: "Review", inbox: true };
    f.state["review.titles"] = { ...f.state["review.titles"], [tab]: `${pane} vs main` };
    const now = f.context.panes(), tabs = f.context.spaces();
    f.context.panes = () => [...now, { pane, mod: "review", tab, title: "review", terminal: null, focused: false }];
    f.context.spaces = () => tabs.map((s) => s.id === space ? { ...s, tabs: [...s.tabs, { id: tab }] } : s);
  };
  return f;
}

test("a quick continuation keeps its Working place, showing its real state meanwhile", () => {
  const f = fixture(), a = f.add("A", "working", 100); f.add("B", "working", 200); f.mod.workOpen = true;
  f.render(); assert.deepEqual(f.working(), ["B", "A"]);
  a.status = "done"; f.render(1100);
  assert.deepEqual(f.working(), ["B", "A"]);
  assert.ok(texts(find(f.tree, "state-A")).includes("Done"));
  a.status = "working"; f.render(1300);
  assert.deepEqual(f.working(), ["B", "A"]);
});

test("a finished run moves to Active once the grace is out; blocked moves at once", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B", "working"); f.mod.workOpen = true;
  f.render(); a.status = "idle"; f.render(1100);
  f.terms[0].turn++; f.render(2000); // the turn's end arriving late doesn't restart the grace
  f.render(3099); assert.deepEqual(f.working(), ["A", "B"]);
  assert.ok(f.timers.some((t) => !t.cancelled && t.at === 3100)); // on time, not on the next second's tick
  f.render(3100); assert.deepEqual(f.active(), ["A"]);
  b.status = "blocked"; f.render(3200); assert.deepEqual(f.active(), ["B", "A"]);
  f.terms.push({ address: "kid", parent: "A", state: "live", status: "error" });
  a.status = "working"; f.render(3300); assert.deepEqual(f.active(), ["A", "B"]);
});

test("a failed turn needs the person: the terminal's error, which agents() can't say", () => {
  const f = fixture(); f.add("A", "done"); f.add("B", "done");
  f.terms[0].status = "error";
  f.render();
  assert.ok(texts(find(f.tree, "state-A")).includes("Needs you"));
  assert.ok(texts(find(f.tree, "state-B")).includes("Done"));
  // A sub-agent with its own pane is in agents() too, where its error reads as something else.
  f.add("kid", "done"); f.terms.at(-1).parent = "B"; f.terms.at(-1).status = "error";
  f.render();
  assert.ok(texts(find(f.tree, "state-B")).includes("Needs you"));
});

test("looking, seq and data order don't reshuffle; equal times go by address", () => {
  const f = fixture(), a = f.add("B", "done"); f.add("A", "done");
  f.render(); assert.deepEqual(f.order, ["A", "B"]);
  a.status = "idle"; a.focused = true; a.seq = 99; f.rows.reverse(); f.render(1500);
  assert.deepEqual(f.order, ["A", "B"]);
  for (const k of f.terms) k.labels.settled = "500:0";
  f.render(1600); f.rows.reverse(); f.render(1700); assert.deepEqual(f.order, ["A", "B"]);
});

test("a short absence and a restart keep each agent's place", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B"), c = f.add("C", "idle", 1500);
  f.render(1600); a.status = "done"; f.render(2000); f.render(4100);
  assert.deepEqual(f.order, ["A", "C", "B"]);
  f.rows = [b, c]; b.status = "working"; f.render(4200);
  f.rows = [a, b, c]; f.render(4300); assert.deepEqual(f.order, ["A", "C", "B"]);
  const g = fixture(); g.data = f.data; g.rows = f.rows; g.terms = f.terms; g.mod.init({}, g.cx);
  g.render(4400); assert.deepEqual(g.order, f.order);
  f.terms[0].state = "exited"; f.rows = [b, c]; c.status = "working"; f.render(4500);
  assert.equal(f.mod.changed.A, undefined);
});

test("a turn that ended unseen is news; unsettling doesn't land on Working", () => {
  const f = fixture(), a = f.add("A", "idle", 200); f.add("B", "idle", 100);
  f.render(); assert.deepEqual(f.order, ["A", "B"]);
  f.terms[1].turn++; f.render(1500); assert.deepEqual(f.order, ["B", "A"]);
  f.terms[0].labels.settled = "1000:0"; f.render(1600);
  a.focused = true; f.settle(); f.render(1700);
  assert.deepEqual(f.working(), []); assert.deepEqual(f.order, ["A", "B"]);
});

// Synced alone to herdr-t3-inbox, there's no agents list to load.
const lists = fs.existsSync(path.join(__dirname, "../t3-agents/main.js"));
test("only the sidebar list in view sets agent.next order", { skip: !lists && "t3-agents isn't here" }, () => {
  const f = fixture(); f.add("A", "working"); f.add("B", "idle", 200); f.render();
  const order = [...f.order], renderAgents = f.loadAgents(); renderAgents();
  assert.deepEqual(f.order, order);
  f.mode = "lists"; renderAgents(); const lists = [...f.order];
  f.render(1500); assert.deepEqual(f.order, lists);
});

test("a pause for the person keeps the run's Working place", () => {
  const f = fixture(), a = f.add("A", "working", 100); f.add("B", "working", 200); f.mod.workOpen = true;
  f.render(); a.status = "blocked"; f.render(1100); assert.deepEqual(f.active(), ["A"]);
  a.status = "working"; f.render(9000); assert.deepEqual(f.working(), ["B", "A"]);
});

test("a reply while sub-agents work comes to Active; read, the run goes on from its start", () => {
  const f = fixture(), a = f.add("A", "idle"); f.mod.workOpen = true;
  f.render(1000); f.terms.push({ address: "kid", parent: "A", state: "live", status: "working" });
  f.render(2000); assert.deepEqual(f.working(), ["A"]);
  a.status = "done"; f.render(3000); assert.deepEqual([f.active(), f.working()], [["A"], []]);
  a.status = "idle"; f.render(4000); assert.deepEqual(f.working(), ["A"]);
  assert.equal(f.mod.changed.A.at, 2000);
});

test("a run out of its grace lands on top of Active, over one that came back meanwhile", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B", "working"); f.mod.workOpen = true;
  f.render(); a.status = "idle"; f.render(1100);
  b.status = "blocked"; f.render(2000); assert.deepEqual(f.active(), ["B"]);
  f.render(3100); assert.deepEqual(f.active(), ["A", "B"]);
});

test("pinned agents skip the grace: unpinned right after stopping, it's in Active", () => {
  const f = fixture(), a = f.add("A", "working"); f.pins = ["A"]; f.mod.workOpen = true;
  f.render(); a.status = "idle"; f.render(1100);
  f.pins = []; f.render(1200);
  assert.deepEqual(f.active(), ["A"]); assert.deepEqual(f.working(), []);
});

test("Settle in view moves down the cards, then from the top", () => {
  const go = (focus) => {
    const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("P", "idle", 100); f.pins = ["P"];
    f.rows.find((a) => a.address === focus).focused = true; f.render(); assert.deepEqual(f.order, ["P", "A", "B"]);
    f.settle(); return f.calls.at(-1)[1].terminal;
  };
  assert.equal(go("A"), "B");
  assert.equal(go("B"), "P");
});

test("times read as T3's", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B", "working"); f.mod.workOpen = true;
  f.render(); f.render(1000 + 3720000);
  assert.deepEqual(texts(find(f.tree, "state-A")).slice(-2), ["1h", "2m"]);
  b.status = "idle"; f.render(4000000); f.render(4002000);
  assert.ok(texts(find(f.tree, "state-B")).includes("just now"));
  f.render(4002000 + 9 * 86400000); assert.ok(texts(find(f.tree, "state-B")).includes("9d"));
});

test("a new scope starts the settled tail over", () => {
  const f = fixture(); f.mod.limit = 35; f.mod.pick({ id: "s1" }, false, f.cx);
  assert.equal(f.mod.limit, 10);
});

test("only a list with nothing in it says so, as T3's", () => {
  const said = (f) => texts(f.tree).filter((s) => /^Nothing/.test(s));
  const f = fixture(); f.render();
  assert.equal(said(f).length, 1, "no agents at all");
  assert.match(said(f)[0], /^Nothing here yet/);
  const a = f.add("A", "idle", 100); f.pins = ["A"]; f.render();
  assert.deepEqual(said(f), [], "a pinned card and an empty Active: blank");
  f.pins = []; a.space = "s1"; f.terms[0].labels.settled = "1100:0"; f.render(1100);
  assert.deepEqual(said(f), [], "all settled: blank");
  f.mod.scope = ["s2"]; f.render();
  assert.deepEqual(said(f), ["Nothing in Two yet"], "a filter that leaves nothing names its space");
  f.mod.scope = ["s2", "gone"]; f.render();
  assert.deepEqual(said(f), ["Nothing in Two yet"]);
});

test("a plain click on Settle leaves no sweep behind to swallow the next click", () => {
  const f = fixture(), a = f.add("A", "idle", 100); f.add("B", "idle", 50); f.add("C", "idle", 30); a.focused = true;
  f.render(); f.mod.hovered = "A"; f.render();
  f.event("settle-A", "on_mouse_down:left");
  // The button's click stops its release there: the sidebar's own mouse-up never comes.
  f.event("settle-A", "on_click"); f.render(1100);
  f.event("t3-inbox-root", "on_mouse_move", { position: { x: 20, y: 300 } });
  assert.equal(f.keys, undefined, "the sidebar doesn't take the keyboard");
  f.event("card-C", "on_click");
  assert.deepEqual([f.calls.at(-1)[0], f.calls.at(-1)[1].terminal], ["agent.focus", "C"], "the next click opens the card at once");
});

test("a plain click on a settled row's undo leaves no sweep behind either", () => {
  const f = fixture(); f.add("A"); f.terms[0].labels.settled = "500:0"; f.mod.open = true;
  f.render(); f.mod.hovered = "A"; f.render();
  f.event("unsettle-A", "on_mouse_down:left"); f.event("unsettle-A", "on_click"); f.render(1100);
  f.event("t3-inbox-root", "on_mouse_move", { position: { x: 20, y: 300 } });
  assert.equal(f.keys, undefined); assert.equal(f.mod.sweep, null);
});

test("a title is bright when it's in view, needs you or is done; hover brightens without changing its weight", () => {
  const f = fixture(); f.env.theme = () => ({ foreground: "bright", muted: "quiet" });
  f.add("Seen", "idle"); f.add("Finished", "done"); f.add("Stuck", "blocked"); f.add("Open", "idle").focused = true;
  f.render();
  const look = (name) => { const { style } = holding(f.tree, name); return [style.text_color[0], Boolean(style.font_medium)]; };
  assert.deepEqual(look("Seen"), ["quiet", false]);
  for (const name of ["Finished", "Stuck", "Open"]) assert.deepEqual(look(name), ["bright", true], name);
  f.mod.hovered = "Seen"; f.render();
  assert.deepEqual(look("Seen"), ["bright", false]);
});

test("a card's marks sit on its third line when it has one, else on the title's", () => {
  const f = fixture(); f.add("m1/A"); f.add("m1/B");
  f.env.panes = () => [{ pane: "m1/A", branch: "dev" }];
  f.render();
  assert.equal(find(lineOf(f.tree, "m1/A"), "machine-m1/A"), null, "the title keeps its whole line");
  assert.ok(find(lineOf(f.tree, "dev"), "machine-m1/A"), "the branch line carries the mark");
  assert.ok(find(lineOf(f.tree, "m1/B"), "machine-m1/B"), "no third line: the title's line carries it");
});

test("a space's monogram is its first glyph, in T3's color for the same name", () => {
  const f = fixture(), run = (code) => vm.runInContext(code, f.context);
  // T3's own cases (apps/mobile/src/lib/projectIcon.test.ts), its colors as Tailwind's 400.
  for (const [name, text, color] of [["t3code", "T", "#2dd4bf"], ["Auto Monogram", "A", "#a3e635"], ["blitzdiff", "B", "#f472b6"],
    ["uoalbumdotclub", "U", "#9ca3af"], ["  Tagium  ", "T", "#a3e635"], ["Café Ünïcode", "C", "#e879f9"], ["web2 app", "W", "#34d399"]]) {
    assert.deepEqual([run(`monogram(${JSON.stringify(name)})`), run(`tint(${JSON.stringify(name)}, true)`)], [text, color], name);
  }
  assert.deepEqual([run(`monogram("智能算量")`), run(`monogram("~/dev")`)], ["智", "D"]);
  assert.equal(run(`monogram("~")`), "", "nothing to spell: the folder instead");
  f.add("A"); f.render();
  const tile = holding(f.tree, "O"), color = run('tint("One", true)');
  assert.deepEqual([tile.style.size[0], tile.style.bg[0], tile.style.text_color[0], tile.style.text_size[0]], [16, color + "24", color, 10.24], "T3's 14% wash of the color, the card's 16px, type as before");
});

test("a space's own icon, found as T3 finds it, replaces its monogram on every card", async () => {
  const f = fixture(), runs = [], written = [];
  // Its terminal is down in the repo: the icon is the repo's, as T3's is its project root's.
  f.env.spaces = () => [{ id: "s1", name: "One", folder: "", machine: "vps", tabs: [{ id: "b1" }] }];
  f.env.panes = () => [{ pane: "A", tab: "b1", cwd: "/w/one/src" }];
  Object.assign(f.context, {
    Buffer, createHash: require("node:crypto").createHash, appHome: () => "/app",
    fs: { exists: async () => false, mkdir: async () => {}, writeFile: async (p, b) => written.push([p, Buffer.from(b).toString()]) },
    readTextFile: async (p) => p === "/w/one/index.html" ? `<link href="/brand/logo.svg" rel="icon">` : null,
    exec: async (cmd, args, opts) => {
      if (cmd === "git") return opts.cwd === "/w/one/src" ? { code: 0, stdout: "/w/one\n" } : { code: 128, stdout: "" };
      runs.push([args.slice(3), opts]);
      if (args[1].startsWith("base64")) return { code: 0, stdout: Buffer.from("<svg/>").toString("base64").replace(/(.{4})/g, "$1\n") };
      return { code: 0, stdout: args.includes("brand/logo.svg") ? "brand/logo.svg" : "" };
    },
  });
  f.add("A"); f.render();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(runs[0][0][0], "favicon.svg", "the well-known places first, in T3's order");
  assert.deepEqual([...runs[1][0]], ["public/brand/logo.svg", "brand/logo.svg"], "then the page's link, public/ first");
  assert.deepEqual({ ...runs[1][1] }, { cwd: "/w/one", on: "vps" }, "looked for on the space's own machine");
  const [[at, bytes]] = written, icon = at.slice("/app/".length);
  assert.match(icon, /^cache\/t3-icons\/[0-9a-f]{16}\.svg$/); assert.equal(bytes, "<svg/>");
  f.render();
  const pic = find(f.tree, "card-A") && (function first(n) { return n?.style?.image ? n : n?.items?.map(first).find(Boolean); })(f.tree);
  assert.deepEqual([pic.style.image[0], pic.style.size[0]], [icon, 16]);
  assert.equal(holding(f.tree, "O"), null, "no monogram beside it");
  f.render(f.now + 59000); await new Promise((done) => setTimeout(done, 0));
  assert.equal(runs.length, 3, "found, it isn't looked for again within ten minutes");
});

// The list moves as T3's (Sidebar.motion.ts): a frame where the rows were, then let go to ease into place.
const flyOf = (f, address) => {
  const walk = (n) => !n || typeof n !== "object" ? null : n.key?.startsWith(`fly-${address}-`) ? n : n.items.map(walk).find(Boolean) ?? null;
  return walk(f.tree);
};
const at = (n) => ({ id: n.key, top: n.style.top?.[0], opacity: n.style.opacity?.[0] });

test("settling slides the card down into Settled and the rows under it up, then lets them go", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("C", "idle", 100);
  f.mod.open = true; f.mod.listH = 600; f.render();
  assert.deepEqual(at(flyOf(f, "B")), { id: "fly-B-0", top: 0, opacity: 1 }, "nothing moves on the first draw");
  f.terms[0].labels.settled = "1100:0"; f.render(1100);
  const a = at(flyOf(f, "A")), b = at(flyOf(f, "B"));
  assert.equal(a.id, "fly-A-1", "a row that moves is a new element, first drawn where it was");
  assert.ok(a.top < 0, "A starts up where its card was, over Settled");
  assert.deepEqual(b, { id: "fly-B-1", top: 84, opacity: 1 }, "B starts a card lower, where it was");
  assert.equal(at(flyOf(f, "C")).top, 84);
  f.render(1116);
  assert.deepEqual([at(flyOf(f, "A")), at(flyOf(f, "B"))], [{ id: "fly-A-1", top: 0, opacity: 1 }, { id: "fly-B-1", top: 0, opacity: 1 }], "then they're let go, the same elements, so Herdr eases them");
  f.render(1200);
  assert.equal(flyOf(f, "B").key, "fly-B-1", "a draw with nothing new moves nothing");
});

test("a new row fades in from 40px up at the top, or in place under a row that stays", () => {
  const f = fixture(); f.add("A", "idle", 200); f.mod.listH = 600; f.render();
  f.add("B", "idle", 300); f.add("Z", "idle", 50); f.render(1100);
  assert.deepEqual(at(flyOf(f, "B")), { id: "fly-B-1", top: -40, opacity: 0 }, "at the top: from 40px up, clear");
  assert.deepEqual(at(flyOf(f, "Z")), { id: "fly-Z-1", top: -84, opacity: 0 }, "under A, which moved a card down: riding with it");
  f.render(1116);
  assert.deepEqual([at(flyOf(f, "B")).opacity, at(flyOf(f, "Z")).top], [1, 0]);
});

test("a row that leaves fades out where it was, then goes", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.mod.listH = 600; f.render();
  f.rows.splice(0, 1); f.terms.splice(0, 1); f.render(1100);
  const ghost = () => { const walk = (n) => !n || typeof n !== "object" ? null : n.key?.startsWith("leaving-A-") ? n : n.items.map(walk).find(Boolean) ?? null; return walk(f.tree); };
  assert.deepEqual([ghost().style.opacity[0], ghost().style.top[0]], [1, 8], "drawn as it was, where it was");
  assert.equal(at(flyOf(f, "B")).top, 84, "B slides up from under it");
  f.render(1116);
  assert.deepEqual([ghost().style.opacity[0], ghost().style.top[0]], [0, 48], "fading, 40px down: nothing above it stays");
  f.render(1300);
  assert.equal(ghost(), null);
});

test("a settled row's time fades out as its undo fades in, and back", () => {
  const f = fixture(); f.add("A"); f.terms[0].labels.settled = "500:0"; f.mod.open = true;
  f.render();
  const corner = () => find(f.tree, "slim-corner-A"), undo = () => find(f.tree, "unsettle-A");
  assert.deepEqual([corner().items[0].style.opacity[0], undo().style.opacity[0]], [1, 0]);
  assert.equal(undo().handlers.on_click, undefined, "faded out, it's no button");
  f.mod.hovered = "A"; f.render();
  assert.deepEqual([corner().items[0].style.opacity[0], undo().style.opacity[0]], [0, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(corner().items[0].style.transition)), ["opacity", { duration: 150, easing: "ease-out" }]);
});

test("a dropped row slides from where it was let go, and nothing moves while dragging", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.mod.open = true; f.mod.listH = 600; f.render();
  f.mod.drag = { from: "B", moved: true, y: 400, grab: 10, height: 82, target: { section: "settled" } };
  f.render(1050);
  assert.equal(flyOf(f, "B").key, "fly-B-0", "dragging: the lanes' gaps move, the rows don't fly");
  // finish() leaves where the ghost was, in the list's terms, then the label lands.
  f.mod.drag = null; f.mod.landed = { key: "B", y: 300 }; f.terms[1].labels.settled = "1100:0"; f.render(1100);
  const b = flyOf(f, "B"), y = f.mod.motion.at.get("B").y;
  assert.deepEqual([b.key, b.style.top[0]], ["fly-B-1", 300 - y]);
});

test("settling shows T3's undo notice over the first shelf for 5s; Undo puts them back where they were", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); a.focused = true; f.mod.listH = 600;
  f.render(); f.settle(); f.render(1000);
  const note = () => { const walk = (n) => !n || typeof n !== "object" ? null : n.key?.startsWith("undo-notice-") && n.key !== "undo-notice-undo" ? n : n.items.map(walk).find(Boolean) ?? null; return walk(f.tree); };
  assert.deepEqual([texts(note())[0], note().style.opacity[0]], ["Settled 1 agent,", 0], "a frame clear, then it fades in");
  f.render(1016);
  assert.equal(note().style.opacity[0], 1);
  assert.ok(find(find(f.tree, "shelves"), "undo-notice-undo"), "over the first shelf's header, as T3 hosts it");
  const undo = find(f.tree, "undo-notice-undo");
  assert.ok("font_medium" in undo.style && "hover" in undo.style, "as T3's InlineButton: medium, underlined on hover");
  // A second settle soon after joins the same notice.
  f.rows.find((x) => x.address === "B").focused = true; a.focused = false; f.settle(); f.render(2000);
  assert.equal(texts(note())[0], "Settled 2 agents,");
  f.event("undo-notice-undo", "on_click");
  assert.deepEqual([f.mod.pending.settled.A, f.mod.pending.settled.B], ["", ""], "both come back, as they were: no news");
  f.render(2016);
  assert.equal(note().style.opacity[0], 0, "fading out");
  f.render(2300);
  assert.equal(note(), null);
  // Left alone, it goes after 5s.
  f.rows.find((x) => x.address === "A").focused = true; f.settle(); f.render(3000); f.render(3016);
  assert.equal(note().style.opacity[0], 1);
  f.render(8000); assert.equal(note().style.opacity[0], 0); assert.equal(find(f.tree, "undo-notice-undo"), null, "no Undo once it's going");
  f.render(8300); assert.equal(note(), null);
});

test("folding Working slides its header down with the list, as T3's markers move, so nothing passes over it", () => {
  const f = fixture(), a = f.add("A", "working", 300); f.add("B", "working", 200); f.add("C", "idle", 100); a.focused = true;
  f.terms[2].labels.settled = "500:0"; f.mod.workOpen = true; f.mod.open = true; f.mod.listH = 600; f.render();
  f.mod.workOpen = false; f.render(1100);
  assert.deepEqual(at(flyOf(f, "m:working")), { id: "fly-m:working-1", top: -84, opacity: 1 }, "the header starts where it was, a card higher");
  assert.equal(flyOf(f, "m:settled").key, "fly-m:settled-0", "Settled sits at the bottom: it doesn't move");
  assert.ok(find(f.tree, "working-header"), "the header's own element is inside its wrapper");
  f.render(1116);
  assert.equal(at(flyOf(f, "m:working")).top, 0);
  f.mod.workOpen = true; f.render(1300);
  assert.equal(at(flyOf(f, "m:working")).top, 84, "unfolding, it goes back up from where it was");
});

test("an agent brought into view that the space filter hides widens it, as T3's route reveal; a filter you pick stays", () => {
  const f = fixture(), a = f.add("A", "idle", 300), b = f.add("B", "idle", 200); b.space = "s2"; b.space_name = "Two";
  a.focused = true; f.mod.scope = ["s1"]; f.render();
  assert.deepEqual(f.active(), ["A"]);
  a.focused = false; b.focused = true; f.render(1100);
  assert.deepEqual([[...f.mod.scope], f.data.get("scope")], [[], "[]"], "kept: the filter is all spaces now");
  assert.ok(f.active().includes("B"));
  f.mod.pick({ id: "s1" }, false, f.cx); f.render(1200);
  assert.deepEqual([...f.mod.scope], ["s1"], "picked while B is in view, the filter holds");
  // A fresh inbox (a reload) leaves the filter as it was, as T3's mount doesn't widen.
  const g = fixture(), c = g.add("C", "idle"); c.space = "s2"; c.focused = true; g.mod.scope = ["s1"]; g.render();
  assert.deepEqual([...g.mod.scope], ["s1"]);
});

test("a sub-agent in view with no row of its own lights its parent's card, as T3's", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200);
  f.terms.push({ address: "c1", parent: "A", state: "live", status: "idle", labels: {} });
  f.context.focused = () => ({ terminal: "c1" }); f.render();
  assert.ok("bg" in find(f.tree, "card-A").style, "A is the row in view");
  assert.ok(!("bg" in find(f.tree, "card-B").style));
  f.mod.settleKey(f.cx);
  assert.match(f.mod.pending.settled.A ?? "", /^\d+:/, "the settle key acts on it too");
});

test("a mod pane in view, a review in a tab of its own, lights no card: Herdr's agent then falls back to the first", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200);
  f.context.focused = () => ({ pane: "pm", tab: "own", terminal: null, agent: "A" }); f.render();
  assert.ok(!("bg" in find(f.tree, "card-A").style) && !("bg" in find(f.tree, "card-B").style));
  // An agent block has no pane: its agent is the one shown, and lit.
  f.context.focused = () => ({ pane: null, terminal: "B", agent: "B" }); f.render();
  assert.ok("bg" in find(f.tree, "card-B").style);
});

test("a mod pane in view beside an agent, a review split off it, lights that agent's card, and the keys go on from it", () => {
  const f = fixture(), a = f.add("A", "idle", 300), b = f.add("B", "idle", 200), c = f.add("C", "idle", 100);
  a.tab = "ta"; b.tab = "tb"; c.tab = "tb";
  f.context.focused = () => ({ pane: "pm", tab: "tb", terminal: null, agent: "A" }); f.render();
  assert.ok("bg" in find(f.tree, "card-B").style, "Herdr's fallback is another tab's agent: the tab's first");
  assert.ok(!("bg" in find(f.tree, "card-A").style) && !("bg" in find(f.tree, "card-C").style));
  assert.equal(f.state["t3-inbox.rows"].view, "B");
  f.context.focused = () => ({ pane: "pm", tab: "tb", terminal: null, agent: "C" }); f.render();
  assert.ok("bg" in find(f.tree, "card-C").style, "the agent chosen in that tab, if there is one");
});

const REVIEW = "card-pane:pm";
const plain = (x) => JSON.parse(JSON.stringify(x));

test("a review in a tab with no agent is a card, at the top of Active when it opens", () => {
  const f = fixture(); f.add("A", "idle", 300); f.review(); f.render();
  assert.deepEqual(f.active(), ["pane:pm", "A"], "opened now, not news from before we were watching");
  const words = texts(find(f.tree, REVIEW));
  assert.ok(words.includes("One") && words.includes("pm vs main"), "which project, and which diff");
  const images = (n) => !n || typeof n !== "object" ? [] : [...(n.style?.image ?? []), ...n.items.flatMap(images)];
  assert.deepEqual(images(find(f.tree, REVIEW)), ["mods/review/logo.svg"], "and what it is, where an agent's card has its program");
  assert.equal(find(f.tree, "settle-pane:pm") && f.mod.pending.settled["pane:pm"], undefined);
});

test("only a mod pane that asks, in a tab with no agent, gets a card", () => {
  const f = fixture(); f.add("A", "idle", 300).tab = "tr"; f.review(); f.render();
  assert.equal(find(f.tree, REVIEW), null, "beside an agent, the agent's card leads to it");
  const g = fixture(); g.add("A", "idle", 300); g.review(); delete g.state["review.program"]; g.render();
  assert.equal(find(g.tree, REVIEW), null, "a mod that publishes nothing, or no review mod at all");
  g.state["review.program"] = { icon: "x" }; g.render();
  assert.equal(find(g.tree, REVIEW), null, "an icon isn't asking: it's for tabs and pane headers");
  const h = fixture(); h.add("A", "idle", 300); h.state["review.titles"] = { gone: "old" }; h.state["review.program"] = { icon: "x", inbox: true }; h.render();
  assert.deepEqual(cards(h.tree), ["A"], "what's left in shared of a closed tab draws nothing");
  const two = fixture(); two.review("pm", "tr"); two.state["other.program"] = { icon: "x", inbox: true };
  const now = two.context.panes();
  two.context.panes = () => [...now, { pane: "pn", mod: "review", tab: "tr", title: "review", terminal: null }];
  two.render();
  assert.deepEqual(cards(two.tree), ["pane:pm"], "one a tab: titles go by tab");
});

test("any mod that asks gets a card, by the same rules", () => {
  const f = fixture(); f.review("pm", "t1", "s2");
  const now = f.context.panes(), tabs = f.context.spaces();
  f.state["notes.program"] = { icon: "x", name: "Notes", inbox: true }; f.state["notes.titles"] = { t9: "todo" };
  f.context.panes = () => [...now, { pane: "pz", mod: "notes", tab: "t9", title: "notes", terminal: null }];
  f.context.spaces = () => tabs.map((s) => s.id === "s1" ? { ...s, tabs: [...s.tabs, { id: "t9" }] } : s);
  f.render();
  assert.deepEqual(cards(f.tree).sort(), ["pane:pm", "pane:pz"]);
  assert.ok(texts(find(f.tree, "card-pane:pz")).includes("todo"));
});

test("a review's card goes where its run says: Working while it analyzes, back on top of Active when it ends", () => {
  const f = fixture(); f.mod.workOpen = true; f.add("A", "idle", 300); f.review(); f.render(1000);
  f.add("B", "idle", 1050); f.render(1100);
  assert.deepEqual(f.active().slice(0, 1), ["B"], "newer news goes above it");
  f.state["review.status"] = { tr: "working" }; f.render(2000);
  assert.ok(f.working().includes("pane:pm"), "busy, on the shelf");
  assert.ok(!f.active().includes("pane:pm"));
  assert.ok(texts(find(f.tree, REVIEW)).includes("Working"));
  f.state["review.status"] = { tr: "done" }; f.render(3000);
  assert.ok(f.working().includes("pane:pm"), "the grace, as an agent's");
  f.render(5100);
  assert.deepEqual(f.active()[0], "pane:pm", "it came back to the person");
  assert.ok(texts(find(f.tree, REVIEW)).includes("Done"));
  f.state["review.status"] = {}; f.render(6000);
  assert.deepEqual(f.active()[0], "pane:pm", "looking at it moves nothing");
  assert.ok(!texts(find(f.tree, REVIEW)).includes("Done"));
  f.state["review.status"] = { tr: "blocked" }; f.render(7000);
  assert.ok(texts(find(f.tree, REVIEW)).includes("Needs you"), "a failure asks");
});

test("clicking a review's card focuses its pane, across spaces", () => {
  const f = fixture(); f.review("pm", "tr", "s2"); f.render();
  f.event(REVIEW, "on_click");
  assert.deepEqual(plain(f.calls.at(-1)), ["pane.focus", { pane: "pm" }]);
});

test("settling a review closes it: no Settled, nothing to undo, and it says so", () => {
  const f = fixture(); f.add("A", "idle", 300); f.review(); f.render();
  f.event(REVIEW, "on_hover", true); f.render();
  assert.ok(find(f.tree, "tip-settle-pane:pm") || find(f.tree, "settle-pane:pm"));
  assert.equal(find(f.tree, "settle-pane:pm").handlers["on_mouse_down:left"], undefined, "no sweep starts from it");
  assert.equal(find(f.tree, "snooze-pane:pm"), null, "no snooze: it has no terminal to hold the label");
  f.calls.length = 0;
  f.event("settle-pane:pm", "on_click");
  assert.deepEqual(plain(f.calls), [["pane.close", { pane: "pm" }]]);
  assert.deepEqual(plain(f.mod.pending), { settled: {}, snoozed: {} }, "no label: it has no terminal");
  assert.equal(f.mod.notice ?? null, null, "no Undo it couldn't keep");
});

test("the settle key on the review in view moves on to the next card, then closes it", () => {
  const f = fixture(); f.add("A", "idle", 300); f.review();
  f.context.focused = () => ({ pane: "pm", tab: "tr", terminal: null, agent: "A" }); f.render();
  assert.ok("bg" in find(f.tree, REVIEW).style, "lit, and no agent's card is");
  assert.ok(!("bg" in find(f.tree, "card-A").style));
  f.calls.length = 0; f.settle();
  assert.deepEqual(plain(f.calls), [["agent.focus", { terminal: "A" }], ["pane.close", { pane: "pm" }]]);
});

test("a review analyzing or failed offers no Settle, by key or on hover, as a busy agent", () => {
  const f = fixture(); f.review(); f.state["review.status"] = { tr: "working" };
  f.context.focused = () => ({ pane: "pm", tab: "tr", terminal: null, agent: null }); f.render();
  f.calls.length = 0; f.settle();
  assert.deepEqual(plain(f.calls), []);
  f.state["review.status"] = { tr: "blocked" }; f.render();
  f.event(REVIEW, "on_hover", true); f.render();
  assert.equal(find(f.tree, "settle-pane:pm").handlers.on_click, undefined);
  f.settle();
  assert.deepEqual(plain(f.calls), []);
});

test("a review's card can't be lifted, nor swept along with agents", () => {
  const f = fixture(); f.add("A", "idle", 300); f.review(); f.render();
  f.event(REVIEW, "on_mouse_down:left");
  assert.equal(f.mod.drag ?? null, null);
  f.event("card-A", "on_hover", true); f.render();
  f.event("settle-A", "on_mouse_down:left"); f.mod.sweep.moved = true; f.render();
  f.event(REVIEW, "on_mouse_move");
  assert.deepEqual([...f.mod.sweep.keys], ["A"]);
});

test("the keys walk a review's card in the order drawn; Herdr's agent.next knows agents only", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("W", "working", 200); f.add("C", "idle", 100); f.review();
  f.mod.workOpen = true; f.terms[2].labels.settled = "500:0"; f.mod.open = true;
  f.context.focused = () => ({ pane: "pm", tab: "tr", terminal: null, agent: "A" }); f.render();
  const rows = f.state["t3-inbox.rows"];
  assert.deepEqual([...rows.order], ["pane:pm", "A", "W", "C"]);
  assert.equal(rows.view, "pane:pm");
  assert.deepEqual([...f.order], ["A", "W", "C"]);
});

test("the space filter hides a review's card, and one brought into view from elsewhere widens it", () => {
  const f = fixture(); f.add("A", "idle", 300); f.review("pm", "tr", "s2");
  f.mod.scope = ["s1"]; f.render();
  assert.equal(find(f.tree, REVIEW), null);
  assert.ok(!f.state["t3-inbox.rows"].order.includes("pane:pm"));
  f.context.focused = () => ({ pane: "pm", tab: "tr", terminal: null, agent: "A" }); f.render(); f.render();
  assert.deepEqual([...f.mod.scope], [], "or the keys would have nowhere to go from it");
  assert.ok(find(f.tree, REVIEW));
  assert.equal(f.state["t3-inbox.rows"].view, "pane:pm");
});

test("a review closed fades where it was, and its record goes with it", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.review(); f.mod.listH = 600; f.render();
  assert.ok(f.mod.changed["pane:pm"]);
  f.context.panes = () => []; f.render();
  assert.ok(find(f.tree, "ghost-card-pane:pm"), "drawn inert while it leaves");
  assert.equal(find(f.tree, REVIEW), null);
  a.status = "working"; f.render();
  assert.equal(f.mod.changed["pane:pm"], undefined, "a pane once closed doesn't come back");
});

test("the rows the next and previous keys walk are the ones drawn, in order, with the one in view", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "working", 200); f.add("C", "idle", 100); f.add("W", "working", 50);
  f.terms[2].labels.settled = "500:0"; a.focused = true; f.render();
  assert.deepEqual(JSON.parse(JSON.stringify(f.state["t3-inbox.rows"])), { order: ["A"], view: "A" }, "folded shelves keep their rows out of the walk");
  f.mod.workOpen = true; f.mod.open = true; f.render();
  const rows = f.state["t3-inbox.rows"];
  assert.deepEqual([...rows.order].sort(), ["A", "B", "C", "W"]);
  assert.equal(rows.order[0], "A");
  assert.equal(rows.order.at(-1), "C", "Settled last, as drawn");
  f.render(); assert.equal(f.state["t3-inbox.rows"], rows, "unchanged, it isn't written again: every write redraws every mod");
});

test("a hovered row that leaves the list (to the folded Working shelf) and comes back brings no card or Settle with it", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200);
  f.render();
  f.event("card-A", "on_hover", true); f.render(f.now + 50); f.render(f.now + 200);
  assert.ok(find(f.tree, "details-card-A"));
  // Gone from the list, no pointer-leave ever comes for it.
  a.status = "working"; f.terms[0].status = "working"; f.render(f.now + 100);
  assert.ok(!f.active().includes("A"));
  a.status = "done"; f.terms[0].status = "done"; f.terms[0].turn++;
  f.render(f.now + 100); f.render(f.now + 3000); f.render(f.now + 100);
  assert.ok(f.active().includes("A"));
  assert.equal(find(f.tree, "details-card-A"), null, "no card: the pointer left long ago");
  assert.equal(find(f.tree, "settle-A").handlers.on_click, undefined, "no Settle offer either");
});

test("the snooze menu is T3's: soonest first, one row per wake minute, tonight gone once past", () => {
  const f = fixture(); f.add("A", "working"); f.mod.workOpen = true; f.mod.hovered = "A";
  const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
  const offered = (now) => {
    f.mod.napMenu = "A"; f.render(now);
    const panel = find(f.tree, "snooze-panel-A");
    return panel.items.filter((row) => row.key && !texts(row).includes("Custom…")).map((row) => texts(row).join(" "));
  };
  assert.deepEqual(offered(at(3, 10)), ["In 1 hour 11:00 am", "In 3 hours 1:00 pm", "This evening 6:00 pm", "Tomorrow 9:00 am", "Next week Mon 9:00 am"]);
  assert.deepEqual(offered(at(3, 15)), ["In 1 hour 4:00 pm", "In 3 hours 6:00 pm", "Tomorrow 9:00 am", "Next week Mon 9:00 am"], "6 pm from either shows once");
  assert.deepEqual(offered(at(3, 19)), ["In 1 hour 8:00 pm", "In 3 hours 10:00 pm", "Tomorrow 9:00 am", "Next week Mon 9:00 am"], "tonight's past");
  assert.deepEqual(offered(at(3, 22)), ["In 1 hour 11:00 pm", "In 3 hours Wed 1:00 am", "Tomorrow 9:00 am", "Next week Mon 9:00 am"], "another day names it");
  assert.deepEqual(offered(at(8, 10)).slice(-1), ["Tomorrow 9:00 am"], "on a Sunday next week is tomorrow");
  f.render(at(3, 10));
  for (let i = 0; i < 4; i++) f.event("snooze-panel-A", "on_key_down", { key: "down" });
  f.event("snooze-panel-A", "on_action:t3_inbox_snooze_pick"); f.flush();
  assert.deepEqual(f.labelled, [`label A snoozed=${at(4, 9)}`], "keys pick; tomorrow is the next calendar day at 9:00");
});

// The fixture has no focus path. What it takes for keys to arrive at all: the handle a Popover moves the keyboard to is
// on the panel, and Enter and Space, the Popover's own, are bound deeper in (checked for real against gpui-shell).
test("the snooze menu's keys are wired to reach it", () => {
  const f = fixture(); f.add("A", "idle", 100); f.render(); f.mod.hovered = "A"; f.render();
  f.event("snooze-menu-A", "on_open_change", true); f.render();
  const pop = find(f.tree, "snooze-menu-A"), panel = find(f.tree, "snooze-panel-A");
  assert.ok(panel.style.track_focus[0]);
  assert.equal(panel.style.track_focus[0], pop.style.track_focus[0], "the keyboard moves to the panel");
  assert.deepEqual(Array.from(f.bound, (b) => b.keystroke), ["enter", "space"]);
  for (const b of f.bound) {
    assert.equal(b.context, panel.style.key_context[0]);
    assert.ok(panel.handlers[`on_action:${b.action}`]);
  }
});

test("the clock opens its menu without lifting or opening the card, and the card's details step aside", () => {
  const f = fixture(); f.add("A", "idle", 100); f.render(); f.mod.hovered = "A"; f.render();
  find(f.tree, "snooze-A").handlers.on_hover(true, f.cx); f.render();
  f.event("card-A", "on_mouse_down:left"); assert.equal(f.mod.drag ?? null, null);
  f.event("card-A", "on_click"); assert.deepEqual(f.calls, []);
  f.event("snooze-menu-A", "on_open_change", true);
  assert.equal(f.mod.napMenu, "A");
  find(f.tree, "snooze-A").handlers.on_hover(false, f.cx); f.mod.hovered = null; f.render();
  assert.equal(find(f.tree, "snooze-A").style.opacity[0], 1, "the pointer has left the card; the clock stays with its menu");
  assert.ok(find(f.tree, "snooze-panel-A"));
  f.mod.details = "A"; f.mod.hovered = "A"; f.render();
  assert.equal(find(f.tree, "details-card-A"), null);
  f.mod.napMenu = null; f.render();
  assert.ok(find(f.tree, "details-card-A"));
});

test("a snoozed agent leaves the cards, working or not; undoing is no news, and it wakes where it was, marked Woke", () => {
  const f = fixture(), b = f.add("B", "idle", 200); f.add("A", "working", 100); f.add("C", "idle", 300);
  f.mod.workOpen = true; f.mod.napOpen = true; f.mod.listH = 600;
  f.render(); f.mod.hovered = "A"; f.mod.napMenu = "A"; f.render();
  f.event("snooze-0-A", "on_click"); f.flush();
  assert.deepEqual(f.labelled, [`label A snoozed=${1000 + 3600000}`]);
  f.render();
  assert.deepEqual([f.working(), f.napping()], [[], ["A"]], "shown at once, before the label is back");
  const undo = find(f.tree, "undo-notice-undo");
  assert.ok(undo, "T3's undo notice"); undo.handlers.on_click({}, f.cx); f.flush();
  assert.equal(f.labelled.at(-1), "label A snoozed=");
  f.render(); assert.deepEqual([f.working(), f.napping()], [["A"], []]);
  f.label("A", "snoozed", String(1000 + 3600000)); f.label("B", "snoozed", String(1000 + 600000)); f.render(1000);
  assert.deepEqual(f.napping(), ["B", "A"], "soonest first");
  assert.ok(texts(find(f.tree, "slim-B")).includes("10m"));
  assert.ok(f.timers.some((t) => !t.cancelled && t.at === 601000), "a timer for the next wake");
  assert.deepEqual(f.order, ["C", "B", "A"], "agent.next reads as the list, snoozed after the cards");
  f.render(601000);
  assert.deepEqual([f.active(), f.napping()], [["C", "B"], ["A"]], "not on top: its own place, as T3's static sort");
  assert.ok(texts(find(f.tree, "woke-B")).includes("Woke"));
  assert.equal(find(f.tree, "tip-woke-B").style.anchor[0], "bottom_center", "its label opens above, as T3's, leaving the title readable");
  assert.ok("font_medium" in holding(f.tree, "B").style, "Woke leads as Done does");
  // Hovered, Woke stays beside the controls; any other state makes way.
  f.mod.hovered = "B"; f.render(601000);
  assert.equal(find(f.tree, "woke-B").style.opacity, undefined);
  assert.ok(!("absolute" in find(f.tree, "controls-B").style));
  f.mod.hovered = "C"; f.render(601000);
  assert.ok(!("absolute" in find(f.tree, "controls-C").style), "the controls take the slot");
  // Looking drops Woke and the snooze, and leaves it where it is.
  f.labelled.length = 0;
  b.focused = true; f.render(602000); f.flush();
  assert.deepEqual(f.labelled, ["label B snoozed="]);
  f.label("B", "snoozed", ""); b.focused = false; f.render(603000);
  assert.deepEqual(f.active(), ["C", "B"]);
  assert.equal(find(f.tree, "woke-B"), null);
});

test("clicking Woke dismisses it, leaving the card alone", () => {
  const f = fixture(); f.add("A", "idle", 200); f.label("A", "snoozed", "500");
  f.render();
  f.event("woke-A", "on_mouse_down:left"); f.event("woke-A", "on_click"); f.flush();
  assert.deepEqual([f.labelled, f.calls], [["label A snoozed="], []]);
});

test("a snoozed agent shows while it needs the person; a failure ends the snooze", () => {
  const f = fixture(), a = f.add("A", "blocked"); f.mod.napOpen = true;
  f.mod.hovered = "A"; f.render();
  assert.equal(find(f.tree, "snooze-A"), null, "needing the person, it can't be snoozed");
  a.status = "working"; f.label("A", "snoozed", String(3600000)); f.render(2000);
  assert.deepEqual(f.napping(), ["A"]);
  a.status = "blocked"; f.render(3000);
  assert.deepEqual([f.active(), f.napping()], [["A"], []]);
  assert.ok(texts(find(f.tree, "state-A")).includes("Needs you"));
  a.status = "working"; f.render(4000);
  assert.deepEqual(f.napping(), ["A"], "answered, it goes back");
  assert.deepEqual(f.labelled, []);
  a.status = "done"; f.terms[0].status = "error"; f.render(5000); f.flush();
  assert.deepEqual(f.labelled, ["label A snoozed="]);
  assert.deepEqual(f.active(), ["A"]);
});

test("an open menu closes when its card comes to need the person", () => {
  const f = fixture(), a = f.add("A", "working"); f.mod.workOpen = true; f.mod.hovered = "A"; f.mod.napMenu = "A"; f.render();
  a.status = "blocked"; f.render(2000);
  assert.equal(f.mod.napMenu, null);
  a.status = "working"; f.render(3000);
  assert.equal(find(f.tree, "snooze-panel-A"), null);
});

test("Wake, pinning and Settle end a snooze; a pinned agent snoozes and keeps its pin", () => {
  const f = fixture(); f.add("A", "idle", 100); f.add("B", "idle", 200); f.add("P", "idle", 300); f.pins = ["P"]; f.mod.napOpen = true;
  f.render(); f.mod.hovered = "P"; f.mod.napMenu = "P"; f.render();
  f.event("snooze-0-P", "on_click"); f.flush();
  f.label("P", "snoozed", String(3601000)); f.mod.hovered = null; f.render(2000);
  assert.deepEqual([f.pins, cards(f.tree), f.napping()], [["P"], ["B", "A"], ["P"]]);
  f.label("P", "snoozed", ""); f.render(3000);
  assert.deepEqual(cards(f.tree), ["P", "B", "A"], "awake, it's back among the pins");
  // Wake leaves it where it was.
  f.label("A", "snoozed", String(3600000)); f.render(4000);
  f.mod.hovered = "A"; f.render(4000); f.event("wake-A", "on_mouse_down:left"); f.event("wake-A", "on_click"); f.flush();
  assert.equal(f.labelled.at(-1), "label A snoozed=");
  f.label("A", "snoozed", ""); f.render(5000);
  assert.deepEqual(f.active(), ["B", "A"]);
  // Pinning a snoozed agent wakes it.
  f.label("B", "snoozed", String(3600000)); f.render(6000);
  f.pins = ["P", "B"]; f.render(7000); f.flush();
  assert.equal(f.labelled.at(-1), "label B snoozed=");
  // Settling a woken agent ends its snooze too.
  f.pins = ["P"]; f.label("B", "snoozed", ""); f.render(7400); f.label("B", "snoozed", "7500"); f.render(8000);
  assert.ok(find(f.tree, "woke-B"));
  f.mod.hovered = "B"; f.render(8000); f.event("settle-B", "on_click"); f.flush();
  assert.ok(f.labelled.includes("label B snoozed="));
});

test("snoozing the agent in view moves on; opened from the shelf it stays, until it's given work", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); a.focused = true;
  f.render(); f.mod.hovered = "A"; f.mod.napMenu = "A"; f.render();
  f.event("snooze-1-A", "on_click");
  assert.deepEqual([f.calls.at(-1)[0], f.calls.at(-1)[1].terminal], ["agent.focus", "B"]);
  f.flush(); f.label("A", "snoozed", String(1000 + 3 * 3600000)); f.render(2000);
  f.event("slim-A", "on_click");
  assert.equal(f.calls.at(-1)[1].terminal, "A", "a click opens it");
  f.render(3000); assert.equal(f.labelled.length, 1, "looking doesn't wake it");
  assert.deepEqual(f.napping(), ["A"], "the one in view shows on the folded shelf");
  a.status = "working"; f.render(4000); f.flush();
  assert.equal(f.labelled.at(-1), "label A snoozed=", "a new turn while in view wakes it");
});

test("a drag wakes a row out of the shelf, with its badge; nothing drags in, and a sweep wakes the run", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("C", "idle", 100); f.mod.napOpen = true; f.mod.listH = 600;
  f.label("A", "snoozed", "3600000"); f.label("B", "snoozed", "3700000"); f.render();
  assert.deepEqual([f.napping(), f.order], [["A", "B"], ["C", "A", "B"]]);
  // A card lifted over the shelf has nowhere to land.
  f.mod.drag = { from: "C", moved: true, y: 400, grab: 10, height: 82, target: { section: "active" } }; f.render();
  f.event("slim-A", "on_mouse_move");
  assert.equal(f.mod.drag.target, null);
  f.event("t3-inbox-root", "on_mouse_up:left"); f.flush();
  assert.deepEqual(f.labelled, []);
  // Out of it into Active.
  f.mod.drag = { from: "A", moved: true, y: 100, grab: 10, height: 30, target: { section: "active" } }; f.render();
  assert.ok(find(f.tree, "badge-wake"), "the lifted row says Wake");
  assert.ok(find(f.tree, "ghost-slim-A"));
  f.event("t3-inbox-root", "on_mouse_up:left"); f.flush();
  assert.deepEqual(f.labelled, ["label A snoozed="]);
  f.label("A", "snoozed", ""); f.mod.dropped = 0; f.render(2000);
  assert.deepEqual([f.active(), f.napping()], [["A", "C"], ["B"]]);
  // A sweep over the shelf's rows wakes them all.
  f.label("A", "snoozed", "3600000"); f.labelled.length = 0; f.render(3000); f.mod.hovered = "A"; f.render(3000);
  f.event("wake-A", "on_mouse_down:left");
  f.event("t3-inbox-root", "on_mouse_move", { position: { x: 20, y: 300 } }); f.render(3000);
  f.event("slim-B", "on_mouse_move"); f.render(3000);
  assert.ok(find(f.tree, "badge-wake"));
  f.event("t3-inbox-root", "on_mouse_up:left"); f.flush();
  assert.deepEqual(f.labelled, ["label A snoozed=", "label B snoozed="]);
});

test("folding Snoozed slides its header with the list, between Working and Settled", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("C", "working", 100); f.mod.listH = 600;
  f.label("A", "snoozed", "3600000"); f.label("B", "settled", "500:0"); f.render();
  const kids = find(f.tree, "shelves").items.map((n) => n.key).filter(Boolean);
  assert.ok(kids.indexOf("snoozed") > -1 && kids.indexOf("snoozed") < kids.indexOf("settled"));
  assert.ok(f.mod.motion.at.has("m:snoozed"), "a marker, so rows don't pass over it");
  const y = f.mod.motion.at.get("m:snoozed").y;
  f.mod.napOpen = true; f.render(1100);
  assert.ok(f.mod.motion.at.get("m:snoozed").y < y, "opened, it moves up to make room");
  assert.deepEqual(f.napping(), ["A"]);
});

test("a run that stops under a snooze skips the grace, as a settled one's: awake, it's in Active", () => {
  const f = fixture(), a = f.add("A", "working", 100); f.label("A", "snoozed", "1500"); f.render();
  a.status = "idle"; f.render(1200);
  f.render(1600);
  assert.deepEqual([f.active(), f.working()], [["A"], []]);
});

test("the next and previous keys walk the shelf's rows when it's open, and only the one in view when it's folded", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("C", "idle", 100);
  f.label("A", "snoozed", "3600000"); f.label("B", "snoozed", "3700000"); f.render();
  assert.deepEqual(Array.from(f.state["t3-inbox.rows"].order), ["C"]);
  a.focused = true; f.render();
  assert.deepEqual(Array.from(f.state["t3-inbox.rows"].order), ["C", "A"]);
  f.mod.napOpen = true; f.render();
  assert.deepEqual(Array.from(f.state["t3-inbox.rows"].order), ["C", "A", "B"]);
});

test("a duration counts from the click; a clock time that passed since the menu was drawn is refused", () => {
  const at = (h, m = 0, s = 0) => new Date(2026, 10, 3, h, m, s).getTime();
  const row = (f, label) => find(f.tree, "snooze-panel-A").items.findIndex((r) => texts(r).includes(label));
  const f = fixture(); f.add("A", "idle", 100); f.add("B", "idle", 90); f.mod.hovered = "A"; f.mod.napMenu = "A"; f.render(at(17, 59, 50));
  const evening = row(f, "This evening");
  f.now = at(18, 0, 10);
  f.event(`snooze-${evening}-A`, "on_click"); f.flush();
  assert.deepEqual(f.labelled, [], "no label for a time gone by");
  assert.equal(f.notifications.at(-1).level, "warning");
  assert.equal(f.mod.notice ?? null, null, "and no Undo for a snooze that didn't happen");
  assert.equal(f.mod.napMenu, "A", "the menu stays, to choose another");
  f.render(at(18, 0, 10));
  assert.equal(row(f, "This evening"), -1);
  assert.equal(find(f.tree, "woke-A"), null);
  f.now = at(18, 0, 40);
  f.event(`snooze-${row(f, "In 1 hour")}-A`, "on_click"); f.flush();
  assert.deepEqual(f.labelled, [`label A snoozed=${at(19, 0, 40)}`], "an hour from the click, not from the draw");
});

test("snoozing with the pointer still on the clock leaves nothing lit: the row opens and details come back", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.mod.napOpen = true; f.mod.listH = 600;
  f.render(); f.mod.hovered = "A"; f.render();
  find(f.tree, "snooze-A").handlers.on_hover(true, f.cx); f.mod.napMenu = "A"; f.mod.napAt = 0; f.render();
  f.event("snooze-panel-A", "on_action:t3_inbox_snooze_pick"); f.flush();
  f.label("A", "snoozed", String(3601000)); f.render(2000);
  assert.equal(f.mod.hot, null);
  f.event("slim-A", "on_click");
  assert.equal(f.calls.at(-1)[1].terminal, "A");
  f.mod.hovered = "B"; f.mod.details = "B"; f.mod.detailsIn = true; f.render(2100);
  assert.ok(find(f.tree, "details-card-B"));
});

test("a label write that keeps failing is tried once a minute from render, and a click still tries at once", async () => {
  const f = fixture(), a = f.add("A", "idle", 100); f.label("A", "snoozed", "5000"); f.render();
  let writes = 0; f.context.hc = async () => { writes++; return { code: 1, stderr: "boom" }; };
  const settle = () => new Promise((r) => setImmediate(r));
  a.focused = true;
  for (let i = 0; i < 4; i++) { f.render(6000 + i); f.flush(); await settle(); }
  assert.deepEqual([writes, f.notifications.length], [1, 1]);
  f.render(6000 + 60000); f.flush(); await settle();
  assert.deepEqual([writes, f.notifications.length], [2, 2], "due again");
  a.focused = false; f.render(); f.flush();
  f.mod.hovered = "A"; f.render(); f.event("woke-A", "on_mouse_down:left"); f.event("woke-A", "on_click"); f.flush(); await settle();
  assert.equal(writes, 3, "the person asked");
});

test("undoing a Settle brings back a snooze that hasn't run out", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); f.label("A", "snoozed", "3600000"); a.focused = true; f.render();
  f.settle(); f.flush();
  assert.deepEqual(f.labelled, ["label A settled=1000:0", "label A snoozed="]);
  f.label("A", "settled", "1000:0"); f.label("A", "snoozed", ""); f.render(1100);
  f.labelled.length = 0;
  find(f.tree, "undo-notice-undo").handlers.on_click({}, f.cx); f.flush();
  assert.deepEqual(f.labelled, ["label A settled=", "label A snoozed=3600000"]);
  f.label("A", "settled", ""); f.label("A", "snoozed", "3600000"); f.render(1200);
  assert.deepEqual(f.napping(), ["A"]);
  // Run out by the time of the Undo, it stays awake, as T3's skips an expired restore.
  f.settle(); f.flush(); f.label("A", "settled", "1200:0"); f.label("A", "snoozed", ""); f.render(1300);
  f.labelled.length = 0; f.now = 3600001;
  find(f.tree, "undo-notice-undo").handlers.on_click({}, f.cx); f.flush();
  assert.deepEqual(f.labelled, ["label A settled="]);
});

test("still at work when it wakes, it says Working and Woke; hovered, Woke stays beside the controls", () => {
  const f = fixture(), a = f.add("A", "working", 100); f.mod.workOpen = true; f.label("A", "snoozed", "500"); f.render();
  assert.deepEqual(f.working(), ["A"]);
  const says = () => texts(find(f.tree, "corner-A"));
  assert.ok(says().includes("Working") && says().includes("Woke"));
  f.mod.hovered = "A"; f.render();
  assert.ok(!says().includes("Working") && says().includes("Woke"));
  assert.notEqual(find(f.tree, "woke-A").style.opacity, 0);
  f.mod.hovered = null; a.status = "idle"; f.render(2000); f.render(9000);
  assert.ok(find(f.tree, "woke-A"), "and it's still there when the run ends");
});

test("a run that ends under a snooze lifts the agent when it wakes: it came back to the person, as T3's returns", () => {
  const f = fixture(), a = f.add("A", "idle", 100); f.add("B", "idle", 200); f.add("C", "idle", 300);
  f.label("A", "snoozed", "100000"); f.render();
  a.status = "working"; f.render(2000);
  a.status = "done"; f.terms[0].status = "done"; f.terms[0].turn++; f.render(50000);
  f.render(100001);
  assert.deepEqual(f.active(), ["A", "C", "B"]);
});

test("a pinned card offers Settle beside the clock, as T3's; settling drops the pin, and Undo brings it back in its place", () => {
  const f = fixture(); f.add("P", "idle", 300); f.add("Q", "idle", 200); f.add("A", "idle", 100); f.pins = ["P", "Q"];
  f.render(); f.mod.hovered = "P"; f.render();
  assert.ok(find(f.tree, "settle-P").handlers.on_click);
  assert.ok(find(f.tree, "snooze-P"));
  assert.equal(find(f.tree, "snooze-menu-P").style.anchor[0], "top_left", "the menu leaves the card readable");
  f.event("settle-P", "on_click"); f.flush();
  assert.deepEqual(f.pins, ["Q"]);
  assert.deepEqual(f.labelled, ["label P settled=1000:0"]);
  f.label("P", "settled", "1000:0"); f.render(1100);
  f.mod.hovered = "Q"; f.render(1100);
  f.event("settle-Q", "on_click"); f.flush();
  assert.deepEqual(f.pins, []);
  f.label("Q", "settled", "1100:0"); f.render(1200);
  assert.equal(f.mod.notice.count, 2);
  find(f.tree, "undo-notice-undo").handlers.on_click({}, f.cx); f.flush();
  assert.deepEqual(f.pins, ["P", "Q"], "a run undone latest first ends as it began");
  f.label("P", "settled", ""); f.label("Q", "settled", ""); f.render(1300);
  assert.deepEqual(cards(f.tree), ["P", "Q", "A"]);
});

test("the settle key and a drag to Settled take a pinned agent too; Undo restores its pin and its snooze", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); f.pins = ["A"]; a.focused = true; f.render();
  f.settle(); f.flush();
  assert.deepEqual([f.pins, f.calls.at(-1)[1].terminal], [[], "B"], "and the view moves on");
  f.label("A", "settled", "1000:0"); a.focused = false; f.render(1100);
  find(f.tree, "undo-notice-undo").handlers.on_click({}, f.cx); f.flush();
  f.label("A", "settled", ""); f.render(1200);
  assert.deepEqual(f.pins, ["A"]);
  // Snoozed under its pin, dragged to Settled: no "Unpinned" notice in the way, and Undo gives back both.
  f.label("A", "snoozed", "3600000"); f.render(1300); f.labelled.length = 0;
  assert.deepEqual([f.pins, f.napping()], [["A"], []], "folded");
  f.mod.napOpen = true; f.mod.open = true; f.mod.listH = 600; f.render(1300);
  f.mod.drag = { from: "A", moved: true, y: 400, grab: 10, height: 30, target: { section: "settled" } }; f.render(1300);
  f.event("t3-inbox-root", "on_mouse_up:left"); f.flush();
  assert.deepEqual(f.pins, []);
  assert.equal(f.mod.notice.action, "Settled");
  f.label("A", "settled", "1300:0"); f.label("A", "snoozed", ""); f.mod.dropped = 0; f.render(1400);
  f.labelled.length = 0;
  find(f.tree, "undo-notice-undo").handlers.on_click({}, f.cx); f.flush();
  assert.deepEqual([f.pins, f.labelled], [["A"], ["label A settled=", "label A snoozed=3600000"]]);
  f.label("A", "settled", ""); f.label("A", "snoozed", "3600000"); f.labelled.length = 0; f.render(1500); f.flush();
  assert.deepEqual([f.labelled, f.napping()], [[], ["A"]], "a pin coming back doesn't wake it");
});

test("a sweep from a pinned card's Settle stays among the pins", () => {
  const f = fixture(); f.add("P", "idle", 300); f.add("Q", "idle", 200); f.add("A", "idle", 100); f.pins = ["P", "Q"];
  f.render(); f.mod.hovered = "P"; f.render();
  f.event("settle-P", "on_mouse_down:left");
  f.event("t3-inbox-root", "on_mouse_move", { position: { x: 20, y: 300 } }); f.render();
  f.event("card-A", "on_mouse_move"); f.event("card-Q", "on_mouse_move"); f.render();
  f.event("t3-inbox-root", "on_mouse_up:left"); f.flush();
  assert.deepEqual(f.pins, []);
  assert.deepEqual(f.labelled.map((l) => l.split("=")[0]), ["label P settled", "label Q settled"]);
});

test("the snooze menu lights nothing until the pointer or a key gets there, and a pick needs a lit row", () => {
  const f = fixture(); f.add("A", "idle", 100); f.render(); f.mod.hovered = "A"; f.render();
  f.event("snooze-menu-A", "on_open_change", true); f.render();
  const lit = () => find(f.tree, "snooze-panel-A").items.filter((r) => r.key).findIndex((r) => r.style.bg);
  const rows = find(f.tree, "snooze-panel-A").items.filter((r) => r.key).length;
  assert.equal(lit(), -1);
  f.event("snooze-panel-A", "on_action:t3_inbox_snooze_pick"); f.flush();
  assert.deepEqual([f.labelled, f.mod.napMenu], [[], "A"], "Enter on nothing does nothing");
  f.event("snooze-panel-A", "on_key_down", { key: "up" }); f.render();
  assert.equal(lit(), rows - 1, "up from nothing is the last row");
  f.event("snooze-panel-A", "on_key_down", { key: "down" }); f.render();
  assert.equal(lit(), 0, "and it wraps");
  find(f.tree, "snooze-1-A").handlers.on_hover(true, f.cx); f.render();
  assert.equal(lit(), 1);
  find(f.tree, "snooze-1-A").handlers.on_hover(false, f.cx); f.render();
  assert.equal(lit(), -1, "the pointer leaving takes the light with it");
});

test("Custom… opens the dialog; its answer snoozes as a preset does, with its Undo, unless the agent came to need the person", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); f.render(); f.mod.hovered = "A"; f.mod.napMenu = "A"; f.render();
  const panel = find(f.tree, "snooze-panel-A").items, i = panel.filter((r) => r.key).findIndex((r) => texts(r).includes("Custom…"));
  assert.equal(panel.filter((r) => r.key).length - 1, i, "last, under a separator");
  const opened = []; f.context.openOverlay = (o) => opened.push(o);
  f.event(`snooze-${i}-A`, "on_click"); f.flush();
  assert.deepEqual([opened[0].mod, opened[0].kind, opened[0].props.customSnooze], ["t3-inbox", "dialog", "A"]);
  assert.deepEqual([f.mod.napMenu, f.labelled], [null, []]);
  f.state["t3-inbox.custom"] = { address: "A", at: 9000000 };
  f.mod.customSnooze(f.cx); f.flush();
  assert.deepEqual(f.labelled, ["label A snoozed=9000000"]);
  assert.equal(f.mod.notice.action, "Snoozed");
  assert.equal(f.state["t3-inbox.custom"], null, "taken once");
  f.labelled.length = 0; f.mod.pending.snoozed = {}; a.status = "blocked"; f.render(2000);
  f.state["t3-inbox.custom"] = { address: "A", at: 9000000 };
  f.mod.customSnooze(f.cx); f.flush();
  assert.deepEqual(f.labelled, []);
});

test("the custom time follows T3's rules: a real local time in the future, or a positive duration", () => {
  const f = fixture(), wake = f.context.customWake, now = new Date(2026, 10, 3, 10, 0).getTime(), day = new Date(2026, 10, 3);
  const at = (time, date = day) => wake({ mode: "date", date, time }, now);
  assert.equal(at("11:30"), new Date(2026, 10, 3, 11, 30).getTime());
  assert.equal(at("9:30", new Date(2026, 10, 4)), new Date(2026, 10, 4, 9, 30).getTime(), "9:30 needs no leading zero");
  for (const bad of ["09:59", "10:00", "25:00", "11:60", "11", "soon", ""]) assert.equal(at(bad), null, bad);
  const lasting = (amount, unit) => wake({ mode: "duration", amount, unit }, now);
  assert.equal(lasting("2", "hours"), now + 7200000);
  assert.equal(lasting("90", "minutes"), now + 5400000);
  assert.equal(lasting("1.5", "days"), now + 129600000);
  for (const bad of ["0", "-1", "", "abc", "1e300"]) assert.equal(lasting(bad, "days"), null, bad);
});

test("the Custom dialog says what's wrong, stays open, and on a good answer hands it to the inbox", () => {
  const f = fixture(), closed = []; f.context.closeOverlay = (id) => closed.push(id);
  f.context.props = () => ({ customSnooze: "A", overlay: "o1" });
  const d = new f.context.Mod(); d.init({}, f.cx);
  let tree = d.render(f.cx);
  const fire = (id, name = "on_click") => { find(tree, id).handlers[name]({}, f.cx); tree = d.render(f.cx); };
  d.time.set_value("nope"); fire("custom-submit");
  assert.ok(texts(find(tree, "custom-error")).includes("Choose a valid date and time in the future."));
  assert.deepEqual(closed, []);
  fire("mode-duration");
  assert.equal(find(tree, "custom-error"), null, "changing course clears it");
  d.amount.set_value("0"); fire("custom-submit");
  assert.ok(texts(find(tree, "custom-error")).includes("Enter a positive duration."));
  d.amount.set_value("30"); fire("unit-minutes"); fire("custom-submit");
  assert.equal(f.state["t3-inbox.custom"].at, f.now + 1800000);
  assert.equal(f.state["t3-inbox.custom"].address, "A");
  assert.deepEqual(closed, ["o1"]);
  assert.equal(f.calls.at(-1)[0], "t3-inbox.custom-snooze");
});

test("the Custom dialog's calendar lets days gone by be seen but not picked, and turns the month", () => {
  const f = fixture(); f.now = new Date(2026, 10, 15, 10, 0).getTime();
  f.context.props = () => ({ customSnooze: "A", overlay: "o1" });
  const d = new f.context.Mod(); d.init({}, f.cx); d.calendarOpen = true;
  let tree = d.render(f.cx);
  assert.equal(find(tree, "day-2026-11-14").handlers.on_click, undefined);
  assert.ok(find(tree, "day-2026-11-15").handlers.on_click, "today can");
  assert.ok(texts(find(tree, "custom-calendar")).includes("November 2026"));
  find(tree, "day-2026-11-20").handlers.on_click({}, f.cx);
  assert.deepEqual([d.date.getDate(), d.calendarOpen], [20, false]);
  d.calendarOpen = true; tree = d.render(f.cx);
  find(tree, "month-on").handlers.on_click({}, f.cx); tree = d.render(f.cx);
  assert.ok(texts(find(tree, "custom-calendar")).includes("December 2026"));
  find(tree, "day-2026-12-25").handlers.on_click({}, f.cx);
  d.time.set_value("09:00"); tree = d.render(f.cx); find(tree, "custom-submit").handlers.on_click({}, f.cx);
  assert.equal(f.state["t3-inbox.custom"].at, new Date(2026, 11, 25, 9, 0).getTime());
});

test("a far-off snooze wakes on time: its timer is re-armed a day at a time", () => {
  const f = fixture(); f.add("A", "idle", 100); f.label("A", "snoozed", String(1000 + 3 * 86400000)); f.render();
  const armed = () => f.timers.filter((t) => !t.cancelled).map((t) => t.at - f.now);
  assert.ok(armed().includes(86400000));
  assert.ok(!armed().some((ms) => ms > 86400000));
  assert.equal(f.mod.nextWake, 1000 + 3 * 86400000);
});
