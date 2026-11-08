// The inbox: no spaces, only the agents still asking for attention, as cards, latest news first.
// Below, as in T3: Working (busy agents, folded) and Settled (put away by hand until new work brings them back).
// Settled lives on the agent's own terminal as `settled=<ms>:<turn>`: it ends with the terminal, every mod
// sees it, and a turn ended since says there was new work even while no window watched. Looking doesn't count.
// A mod pane in a tab with no agent, which no agent's card leads to, has a card too if its mod asks (`inbox: true` in
// shared("<mod>.program")): it goes by what its mod reports as an agent does. It's a view whose state lives elsewhere, so
// Settle closes it: no Settled, no Undo, no pin and no drag.
// Snoozed, as T3's: `snoozed=<wake ms>` hides an agent, working or not, on a shelf of its own until then, and it wakes
// where it was, marked Woke until looked at. It shows meanwhile while it needs the person; a failure, a new turn in
// view, Wake, a pin or Settle ends it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, Popup, InputState, Input } from "gpui-base";
import { agents, terminals, panes, spaces, focused, run, hc, exec, notify, theme, shared, setShared, setAgentOrder, props, nextCommand, settings, layout, openOverlay, closeOverlay } from "herdr";
// New space through t3-new-menu, which asks the machine, then the folder on it. `machine` given (null: this
// computer) skips to its folders. mod.open takes no props, so where to start goes by shared state.
function newSpace(machine) {
  // Shared state keeps no undefined (it comes back null, this computer): `pick` says to ask for the machine.
  setShared("t3-new-menu.start", { machine: machine ?? null, pick: machine === undefined, at: Date.now() });
  run("mod.open", { name: "t3-new-menu" });
}

import { modStatus, namer, programOf } from "./name.js";
import { kidStatus, descendants, ownStatus, treeStatus } from "./tree.js";
import { projectMark } from "./project.js";
import { tip, tipMark } from "./tip.js";
import { programIcon, detailsLive, detailsFor, detailsLine, detailsCard } from "./details.js";
// Local change: one list by newest finish, without Pinned / Working / Snoozed / Settled, Settle, Snooze or dragging.
const FLAT = true;

const icon = programIcon;

const BUSY = new Set(["working", "blocked"]);
// The settled tail opens on this many, then grows by MORE.
const FIRST = 10, MORE = 25;
// A run that stops stays on the Working shelf this long (ms), as in T3: a quick continuation doesn't move it twice.
const GRACE = 2000;
// A label write render keeps asking for waits this long (ms) after failing.
const RETRY = 60000;
// A custom snooze can be far off; its timer needn't be.
const DAY = 86400000;
// The last word when times tie, so the order doesn't follow the order the data came in.
const byAddress = (x, y) => x.address.localeCompare(y.address);

// As T3's sidebar times: no "ago", nothing past days.
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

// How long it's been working, as T3's Working pill: 9s, 4m, 1h 5m.
function took(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000)), m = Math.floor(s / 60);
  return s < 60 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Time left on a snooze, rounded up as T3's: 10m, 3h, 2d.
function left(ms, now) {
  const m = Math.max(1, Math.ceil((ms - now) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.ceil(m / 60)}h` : `${Math.ceil(m / 1440)}d`;
}

// T3's default snooze menu, in local time: soonest first, one row per wake minute, tonight's gone once it's past.
function presets(now) {
  const d = new Date(now), at = (days, h) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h).getTime();
  const time = (ms) => { const w = new Date(ms); return `${w.getHours() % 12 || 12}:${String(w.getMinutes()).padStart(2, "0")} ${w.getHours() < 12 ? "am" : "pm"}`; };
  const day = (ms) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms).getDay()]} ${time(ms)}`;
  const inFrom = (hours) => { const ms = now + hours * 3600000; return { label: `In ${hours} hour${hours === 1 ? "" : "s"}`, at: ms, hours, when: new Date(ms).getDate() === d.getDate() ? time(ms) : day(ms) }; };
  const monday = at((1 - d.getDay() + 7) % 7 || 7, 9);
  return [inFrom(1), inFrom(3), { label: "This evening", at: at(0, 18), when: time(at(0, 18)) }, { label: "Tomorrow", at: at(1, 9), when: time(at(1, 9)) }, { label: "Next week", at: monday, when: day(monday) }]
    .filter((p) => p.at > now).sort((x, y) => x.at - y.at)
    .filter((p, i, xs) => xs.findIndex((q) => Math.floor(q.at / 60000) === Math.floor(p.at / 60000)) === i);
}

// T3's Custom snooze: when a date and time or a duration wakes, or null for a time that doesn't exist or has passed.
function customWake({ mode, date, time, amount, unit }, now) {
  let at;
  if (mode === "duration") {
    const n = Number(amount);
    if (!(n > 0)) return null;
    at = now + n * { minutes: 60000, hours: 3600000, days: DAY }[unit];
  } else {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!m) return null;
    const w = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(m[1]), Number(m[2]));
    // 25:00 rolls over, and a local time a clock change skips moves.
    if (w.getHours() !== Number(m[1]) || w.getMinutes() !== Number(m[2])) return null;
    at = w.getTime();
  }
  return Number.isFinite(new Date(at).getTime()) && at > now ? at : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The Custom dialog: this copy's own inputs, made once in init. It opens on an hour from now, as T3's.
function initCustom(view) {
  const soon = new Date(Date.now() + 3600000), pad = (n) => String(n).padStart(2, "0");
  view.mode = "date";
  view.unit = "hours";
  view.date = soon;
  view.month = new Date(soon.getFullYear(), soon.getMonth(), 1);
  view.calendarOpen = false;
  view.error = null;
  const field = (placeholder, value) => {
    const input = InputState.new({ placeholder, value });
    input.on("change", (_e, cx) => { view.error = null; cx.notify(); });
    input.on("submit", (_e, cx) => { submitCustom(view); cx.notify(); });
    return input;
  };
  view.time = field("HH:MM", `${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
  view.amount = field("2", "2");
  view.time.focus();
}

function submitCustom(view) {
  const at = customWake({ mode: view.mode, date: view.date, time: view.time.value(), amount: view.amount.value(), unit: view.unit }, Date.now());
  if (at === null) {
    view.error = view.mode === "date" ? "Choose a valid date and time in the future." : "Enter a positive duration.";
    return;
  }
  setShared("t3-inbox.custom", { address: props().customSnooze, at });
  closeOverlay(props().overlay);
  run("t3-inbox.custom-snooze");
}

// A month to pick a day from; days gone by can't be picked. The kit has no calendar of its own.
function calendar(view, t) {
  const y = view.month.getFullYear(), m = view.month.getMonth(), lead = new Date(y, m, 1).getDay();
  const now = new Date(Date.now()), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const turn = (id, glyph, label, by) => h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover))
    .role("button").accessibility_label(label)
    .on_click((_e, cx) => { view.month = new Date(y, m + by, 1); cx.notify(); })
    .child(svg(`mods/workspace-chrome/chevron-${glyph}.svg`).size(14).text_color(t.muted));
  const day = (d) => {
    const past = d.getTime() < today, on = same(d, view.date);
    return h_flex().id(`day-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`).size(32).items_center().justify_center().rounded(6)
      .text_color(on ? t.solid_foreground : past || d.getMonth() !== m ? t.dim : t.foreground)
      .when(past, (el) => el.opacity(0.5))
      .when(on, (el) => el.bg(t.solid))
      .when(!past, (el) => el.when(!on, (b) => b.hover((s) => s.bg(t.hover))).role("button").accessibility_label(`${MONTHS[d.getMonth()]} ${d.getDate()}`)
        .on_click((_e, cx) => { view.date = d; view.calendarOpen = false; view.error = null; cx.notify(); }))
      .child(String(d.getDate()));
  };
  const weeks = Array.from({ length: 6 }, (_, w) => h_flex().children(Array.from({ length: 7 }, (_, i) => day(new Date(y, m, 1 - lead + w * 7 + i)))));
  return v_flex().id("custom-calendar").mt(4).p(8).gap(4).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(12)
    .child(h_flex().h(28).items_center()
      .child(turn("month-back", "left", "Previous month", -1))
      .child(div().flex_1().text_center().font_medium().text_color(t.foreground).child(`${MONTHS[m]} ${y}`))
      .child(turn("month-on", "right", "Next month", 1)))
    .child(h_flex().children(["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((w) => div().w(32).text_center().text_color(t.dim).child(w))))
    .children(weeks);
}

function customView(view) {
  const t = theme(), done = () => closeOverlay(props().overlay);
  const label = (text) => div().text_size(12).text_color(t.muted).child(text);
  const input = (state) => h_flex().h(32).px(10).rounded(6).border(1).border_color(t.border).bg(t.input).items_center()
    .child(Input.new(state).flex_1().h_full().text_size(13).text_color(t.foreground));
  const choice = (id, on, name, pick) => h_flex().id(id).h(28).flex_1().px(8).rounded(6).items_center().justify_center().text_size(12)
    .bg(on ? t.selected : t.input).text_color(on ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
    .role("button").accessibility_label(name)
    .on_click((_e, cx) => { pick(); view.error = null; cx.notify(); }).child(name);
  // Buttons, title and padding as the shipped confirm dialog's.
  const button = (id, text, primary, act) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(primary ? t.solid : t.input).text_size(12)
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
    .cursor_pointer().hover((s) => s.opacity(0.88)).role("button").accessibility_label(text).on_click(act).child(text);
  const when = view.mode === "date"
    ? h_flex().gap(12)
      .child(v_flex().flex_1().min_w(0).gap(6).child(label("Date"))
        .child(Popover.new("custom-date").anchor("top_left").open(view.calendarOpen)
          .on_open_change((open, cx) => { view.calendarOpen = open; cx.notify(); })
          .trigger(h_flex().id("custom-date-button").h(32).px(10).gap(8).rounded(6).border(1).border_color(t.border).bg(t.input).items_center().cursor_pointer()
            .role("button").accessibility_label("Choose snooze date")
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`${MONTHS[view.date.getMonth()].slice(0, 3)} ${view.date.getDate()}, ${view.date.getFullYear()}`))
            .child(svg("mods/t3-inbox/calendar.svg").size(14).flex_none().text_color(t.muted)))
          .when(view.calendarOpen, (el) => el.content(calendar(view, t)))))
      .child(v_flex().flex_1().min_w(0).gap(6).child(label("Time")).child(input(view.time)))
    : h_flex().gap(12)
      .child(v_flex().w(110).flex_none().gap(6).child(label("Snooze for")).child(input(view.amount)))
      .child(v_flex().flex_1().min_w(0).gap(6).child(label("Unit")).child(h_flex().h(32).gap(4).items_center()
        .children([["minutes", "Minutes"], ["hours", "Hours"], ["days", "Days"]].map(([u, name]) => choice(`unit-${u}`, view.unit === u, name, () => { view.unit = u; })))));
  return v_flex().id("custom-snooze").size_full().p(18).gap(14).bg(t.popover).text_size(13)
    .child(v_flex().gap(4)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Custom snooze"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_color(t.muted).child("Choose when snoozed agents return to your inbox.")))
    .child(h_flex().gap(4)
      .child(choice("mode-date", view.mode === "date", "Date and time", () => { view.mode = "date"; view.time.focus(); }))
      .child(choice("mode-duration", view.mode === "duration", "Duration", () => { view.mode = "duration"; view.amount.focus(); })))
    .child(when)
    .when(Boolean(view.error), (el) => el.child(div().id("custom-error").role("alert").text_color(t.blocked).child(view.error)))
    .child(h_flex().mt_auto().gap(8).items_center()
      .child(div().flex_1())
      .child(button("custom-cancel", "Cancel", false, done))
      .child(button("custom-submit", "Snooze", true, (_e, cx) => { submitCustom(view); cx.notify(); })));
}

// Local change: a card's right-click menu, a pointer popup that is another copy of this mod (`props().cardMenu`:
// { address, pane, tab, space, mod, kids, folded }). Folding sub-agents is the card's copy's localStorage, so the
// menu asks for it through shared `t3-inbox.kids-toggle`. Items are [label, icon, act] or "-" (a divider).
const MENU_ROW = 30, MENU_SEP = 9;
function cardMenuItems(c) {
  const sep = "-";
  if (c.mod) return [
    ["Open", "square", () => run("pane.focus", { pane: c.pane })],
    sep,
    ["Close pane", "x", () => run("pane.close", { pane: c.pane })],
  ];
  return [
    ["Open", "square", () => c.lost ? run("pane.focus", { pane: c.pane }) : run("agent.focus", { terminal: c.address })],
    ["Peek", "layers", () => run("terminal.peek", { terminal: c.address })],
    ...(c.kids ? [[c.folded ? "Expand sub-agents" : "Collapse sub-agents", c.folded ? "chevron-down" : "chevron-right",
      () => setShared("t3-inbox.kids-toggle", { address: c.address, at: Date.now() })]] : []),
    sep,
    ...(c.pane ? [["Split right", "panel-right", () => run("pane.split", { direction: "right", pane: c.pane })]] : []),
    ...(c.space ? [["New tab in space", "plus", () => run("tab.new", { space: c.space })]] : []),
    ...(c.tab ? [["Rename tab", "square-pen", () => run("tab.rename", { id: c.tab })]] : []),
    ...(c.space ? [["Rename space", "square-pen", () => run("space.rename", { id: c.space })]] : []),
    sep,
    ...(c.pane ? [["Close pane", "x", () => run("pane.close", { pane: c.pane })]] : []),
    ...(c.tab ? [["Close tab", "x", () => run("tab.close", { id: c.tab })]] : []),
  ];
}
const cardMenuHeight = (c) => cardMenuItems(c).reduce((h, it) => h + (it === "-" ? MENU_SEP : MENU_ROW), 10);

function openCardMenu(a, kids, folded) {
  const c = { address: a.address, pane: a.pane ?? null, tab: a.tab ?? null, space: a.space ?? null, mod: Boolean(a.mod), ...(a.lost ? { lost: true } : {}), kids, folded };
  openOverlay({ mod: "t3-inbox", kind: "popup", width: 210, height: cardMenuHeight(c), props: { cardMenu: c } });
}

function initCardMenu(view, cx) {
  view.at = -1;
  view.handle = cx.focus_handle();
  view.handle.focus();
}

function cardMenuView(view) {
  const t = theme(), c = props().cardMenu, list = cardMenuItems(c);
  const acts = list.filter((it) => it !== "-");
  const choose = (it) => { if (!it) return; closeOverlay(props().overlay); it[2](); };
  let k = -1;
  return v_flex().id("card-menu").track_focus(view.handle).size_full().p(5).bg(t.popover).text_size(12.8)
    .on_key_down((e, cx) => {
      if (e.key === "down") view.at = (view.at + 1) % acts.length;
      else if (e.key === "up") view.at = (view.at <= 0 ? acts.length : view.at) - 1;
      else if (e.key === "enter") return choose(acts[view.at]);
      else if (e.key === "escape") return closeOverlay(props().overlay);
      else return;
      cx.stop_propagation();
      cx.notify();
    })
    .children(list.map((it, i) => {
      if (it === "-") return div().id(`card-menu-sep-${i}`).mx(7).my(4).h(1).flex_none().bg(t.border);
      const n = ++k;
      return h_flex().id(`card-menu-${n}`).h(MENU_ROW).px(8).gap(9).flex_none().rounded(7).items_center().text_color(t.foreground)
        .role("button").accessibility_label(it[0])
        .when(n === view.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); choose(it); })
        .child(svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(it[0]));
    }));
}

export default class Inbox extends View {
  init(_props, cx) {
    if (props()?.customSnooze) return initCustom(this);
    if (props()?.cardMenu) return initCardMenu(this, cx);
    // A card menu's fold request already made before this copy started isn't for it.
    this.kidsToggleSeen = shared("t3-inbox.kids-toggle")?.at ?? 0;
    // Each agent's last state, when we saw it set going or come back (ms; 0: before we were watching), the turns
    // it had ended then, and for one that just stopped, when its run started.
    this.changed = JSON.parse(localStorage.getItem("changes") ?? "{}");
    this.open = localStorage.getItem("open") === "true";
    this.workOpen = localStorage.getItem("working-open") === "true";
    this.napOpen = localStorage.getItem("snoozed-open") === "true";
    // Cards whose sub-agent tree is folded (open by default).
    this.kidsFolded = JSON.parse(localStorage.getItem("kids-folded") ?? "[]");
    // FLAT: when each agent last finished, so a working one keeps its place.
    this.doneAt = JSON.parse(localStorage.getItem("done-at") ?? "{}");
    // Commits to push / pull per [machine, folder] (syncOf in render), and the reads under way.
    this.sync = {};
    this.syncing = new Set();
    // The card whose snooze menu is open, and the row its keys are on.
    this.napMenu = null;
    this.napAt = -1;
    this.napKeys = cx.focus_handle();
    this.limit = FIRST;
    // Labels written but not back from the core yet: label → address → value ("" = removed).
    this.pending = { settled: {}, snoozed: {} };
    // Writes that failed, and when.
    this.refused = {};
    this.hovered = null;
    // Each row's drawn height (logical px, by `kind:address`), for where rows sit when the list moves.
    this.rowH = {};
    // The spaces shown, as T3 scopes threads to projects; none: all of them.
    this.scope = JSON.parse(localStorage.getItem("scope") ?? "[]");
    this.scopeOpen = false;
    this.scopeAt = 0;
    this.search = InputState.new({ placeholder: "Search spaces…" });
    this.search.on("change", (_e, cx) => { this.scopeAt = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.pick(this.matches()[this.scopeAt], false, cx));
    // Takes the keyboard while a row is lifted, so Esc can put it back.
    this.keys = cx.focus_handle();
    // "Working 9s" counts up only while such a card shows.
    cx.timer.every(1000, (cx) => { if (this.ticking) cx.notify(); });
    // The cards' times (5m, 2h) move on by the minute, as T3's do.
    cx.timer.every(60000, (cx) => cx.notify());
    // `t3-inbox.settle` (cmd-shift-s in keys.json): see settleKey in render. `t3-inbox.clear`: Clear's confirm dialog.
    // `t3-inbox.custom-snooze`: the Custom dialog, a copy of this mod with no loop of its own.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "settle") this.settleKey?.(cx);
        else if (command === "clear") this.clearSettled?.();
        else if (command === "custom-snooze") this.customSnooze?.(cx);
        cx.notify();
      }
    });
  }

  matches() {
    const q = this.search.value().toLowerCase();
    return [{ id: null, name: "All spaces" }, ...spaces()].filter((s) => s.name.toLowerCase().includes(q));
  }

  // A click shows that space alone; shift-click adds or removes it and keeps the menu open, as in T3.
  pick(s, shift, cx) {
    if (!s) return;
    this.scope = !s.id ? [] : !shift ? [s.id] : this.scope.includes(s.id) ? this.scope.filter((id) => id !== s.id) : [...this.scope, s.id];
    localStorage.setItem("scope", JSON.stringify(this.scope));
    // A new scope starts the settled tail over, as T3's does.
    this.limit = FIRST;
    if (!shift) this.scopeOpen = false;
    cx.notify();
  }

  // Takes each agent's state as working, blocked or idle (done counts as idle: looking at it isn't news).
  // A run's place in Working is when it started, as T3's is the person's message: a pause for them, or a stop
  // that goes on within the grace, is the same run. Pinned and settled ones skip the grace, as in T3: their
  // place doesn't hang on it. A turn ended while we weren't watching is news too.
  track(list, all, now, cx) {
    let dirty = false;
    for (const { address, s, turn, excluded, first } of list) {
      let was = this.changed[address];
      // The grace ran out: back with the person as of then, so it lands on top, and the run is over.
      if (was?.s === "idle" && was.start != null && (excluded || now - was.at >= GRACE)) {
        was = this.changed[address] = { s: "idle", at: excluded ? now : was.at + GRACE, turn: was.turn };
        dirty = true;
      }
      if (was?.s === s && (s !== "idle" || turn <= (was.turn ?? turn))) continue;
      const grace = was?.s === "working" && s === "idle" && !excluded;
      if (grace) cx.timer.after(GRACE, (cx) => cx.notify());
      this.changed[address] = !was ? { s, at: first ?? 0, turn } // First sight says nothing about when it changed.
        : s === "working" ? { s, at: was.start ?? now, turn }
        // A pause for the person, stuck or replying while its sub-agents work: the run keeps its start.
        : s === "blocked" || s === "done" ? { s, at: now, turn, start: was.s === "working" ? was.at : was.start }
        : grace ? { s, at: now, turn, start: was.at } // Stopped: the grace begins.
        : was.start != null && was.s === "idle" ? { ...was, turn } // The turn's end arriving within it.
        : { s, at: now, turn };
      dirty = true;
    }
    if (!dirty) return;
    // Only ended agents lose their record: one missing from the list for a moment comes back to its place.
    const listed = new Set(list.map((a) => a.address));
    const ended = new Set(all.filter((k) => k.state !== "live").map((k) => k.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && (ended.has(k) || k.startsWith("pane:") || now - c.at > 30 * 86400000)) delete this.changed[k];
    localStorage.setItem("changes", JSON.stringify(this.changed));
  }

  // Shown at once; the label comes back from the core a moment later.
  setLabel(key, addr, value, cx) {
    this.pending[key][addr] = value;
    cx.spawn(async (cx) => {
      const r = await hc(["label", addr, `${key}=${value}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) return;
      delete this.pending[key][addr];
      this.refused[`${key} ${addr} ${value}`] = Date.now();
      notify({ title: "Couldn't update the agent", body: r.stderr.trim(), level: "error" });
      cx.notify();
    });
  }

  // For what render asks for on every draw until the label changes: unchecked, a failing write would be retried and
  // reported on every draw.
  setLabelDue(key, addr, value, cx) {
    const write = `${key} ${addr} ${value}`;
    if (Date.now() - (this.refused[write] ?? -Infinity) < RETRY) return;
    delete this.refused[write];
    this.setLabel(key, addr, value, cx);
  }

  // T3's undo notice (showThreadUndoNotice): the latest run of one action, "Settled 2 agents", undone together for
  // 5s, then gone. A new notice fades in (a frame clear first: Herdr eases only later changes); it fades out going.
  remember(action, count, undo, cx) {
    const live = this.notice?.live && this.notice.action === action ? this.notice : null;
    const n = live ?? { action, count: 0, undos: [], gen: (this.notice?.gen ?? 0) + 1, shown: false };
    n.count += count; n.undos.push(undo); n.live = true;
    this.notice = n;
    const ran = n.undos.length;
    if (!live) cx.timer.after(16, (cx) => { if (this.notice === n && n.live) { n.shown = true; cx.notify(); } });
    cx.timer.after(5000, (cx) => { if (this.notice === n && n.undos.length === ran) this.forget(cx); });
  }

  forget(cx) {
    const n = this.notice;
    if (!n?.live) return;
    n.live = false; n.shown = false;
    cx.timer.after(250, (cx) => { if (this.notice === n) { this.notice = null; cx.notify(); } });
    cx.notify();
  }

  // Ends a drag or sweep, and hands the keyboard back to the pane that had it, unless the drop moved on to
  // another agent. Not FocusHandle.release(): that frees the handle, and the next drag would throw.
  // `this.back` is set only once something lifted.
  endDrag(restore = true) {
    const back = restore ? this.back : null;
    this.drag = this.sweep = this.back = null;
    if (back?.pane) run("pane.focus", { pane: back.pane });
    else if (back?.terminal) run("pane.focus", { terminal: back.terminal });
    return null;
  }

  detailsLive() { return detailsLive(this); }
  detailsFor(address, cx) { detailsFor(this, address, cx); }

  render(cx) {
    if (props()?.customSnooze) return customView(this);
    if (props()?.cardMenu) return cardMenuView(this);
    const t = theme(), now = Date.now();
    const runs = agents(), all = terminals(), ps = panes(), sp = spaces(), f = focused();
    // A card menu's Collapse / Expand sub-agents (see openCardMenu).
    const toggle = shared("t3-inbox.kids-toggle");
    if (toggle?.at && toggle.at !== this.kidsToggleSeen) {
      this.kidsToggleSeen = toggle.at;
      const was = this.kidsFolded.includes(toggle.address);
      this.kidsFolded = was ? this.kidsFolded.filter((x) => x !== toggle.address) : [...this.kidsFolded, toggle.address];
      localStorage.setItem("kids-folded", JSON.stringify(this.kidsFolded));
    }
    // Mod panes that ask for a card (see the top), one a tab. `pane:<id>` is their address, in t3-inbox.rows too.
    // A pane whose program is an agent that stopped reporting (a Claude session moved to the background clears its
    // terminal's status) isn't in agents(); it still gets a card, idle unless what's under it works. Its pane is its way in.
    const lost = ps.filter((p) => p.terminal && p.app && p.status == null && !runs.some((a) => a.address === p.terminal)).flatMap((p) => {
      const s = sp.find((x) => x.tabs.some((c) => c.id === p.tab));
      return s ? [{ ...p, address: p.terminal, status: "idle", lost: true, focused: p.pane === f?.pane, space: s.id, space_name: s.name }] : [];
    });
    const every = [...runs, ...lost, ...sp.flatMap((s) => s.tabs.flatMap((c) => {
      const p = ps.find((x) => x.tab === c.id && x.mod && programOf(x)?.inbox);
      return p && !runs.some((a) => a.tab === c.id) ? [{ ...p, address: `pane:${p.pane}`, status: modStatus(p) ?? "idle", focused: p.pane === f?.pane,
        space: s.id, space_name: s.name, program: { name: p.title, ...programOf(p) } }] : [];
    }))];
    // The row in view: the focused agent's, or for a sub-agent with no row of its own (shown in a block, a peek), its
    // nearest listed ancestor's, as T3's resolveSidebarRowThreadId lights the parent of an open sub-agent.
    const inView = (() => {
      const own = every.find((a) => a.focused);
      if (own) return own.address;
      const byAddress = new Map(all.map((k) => [k.address, k])), seen = new Set();
      // A mod pane has no agent of its own: it stands for the one beside it in its tab, if any. Herdr's agent is the
      // chosen one, else the first of all, so it counts only there, or for an agent block, which has no pane.
      if (f?.pane && !f.terminal) {
        const here = every.filter((a) => a.tab === f.tab);
        return (here.find((a) => a.address === f.agent) ?? here[0])?.address ?? null;
      }
      let k = byAddress.get(f?.pane ? f.terminal : f?.agent ?? f?.terminal);
      while (k && !every.some((a) => a.address === k.address) && !seen.has(k.address)) { seen.add(k.address); k = byAddress.get(k.parent); }
      return k && every.some((a) => a.address === k.address) ? k.address : null;
    })();
    // Read live on the agent itself, so a key or click right after focus moves goes by where it is now.
    const stoodIn = inView !== null && !every.some((a) => a.focused);
    const viewing = (a) => a.focused || (stoodIn && a.address === inView);
    // As T3's route reveal: an agent brought into view from elsewhere (a key, the picker, its pane) that the space
    // filter hides widens the filter to every space, kept. Not on the first draw, and a filter you pick isn't undone.
    if (this.inView !== undefined && inView && inView !== this.inView && this.scope.length) {
      const a = every.find((x) => x.address === inView);
      if (a && !this.scope.includes(a.space)) { this.scope = []; localStorage.setItem("scope", "[]"); this.limit = FIRST; }
    }
    this.inView = inView;
    // A space that's gone reads as all; its id stays stored, so the scope returns with it.
    const scope = this.scope.filter((id) => sp.some((s) => s.id === id));
    const list = scope.length ? every.filter((a) => scope.includes(a.space)) : every;
    const listed = new Map(every.map((a) => [a.address, a.status]));
    const term = new Map(all.map((k) => [k.address, k]));
    for (const [key, of] of Object.entries(this.pending)) {
      for (const [k, v] of Object.entries(of)) if (!term.has(k) || (term.get(k).labels?.[key] ?? "") === v) delete of[k];
    }
    const settledAt = (a) => {
      const v = this.pending.settled[a.address] ?? term.get(a.address)?.labels?.settled;
      return v ? v.split(":").map(Number) : null;
    };
    const kids = new Map(every.map((a) => [a.address, descendants(all, a.address).map((k) => kidStatus(k, listed))]));
    // It, or anything under it, is working or needs the person.
    const busy = (a) => BUSY.has(a.status) || kids.get(a.address).some((s) => BUSY.has(s));
    // New work brings a settled agent back: busy now, or a turn ended since it was settled. Hidden ones too.
    for (const a of every) {
      const s = settledAt(a);
      if (s && (busy(a) || (term.get(a.address)?.turn ?? 0) > s[1])) this.setLabelDue("settled", a.address, "", cx);
    }
    // It with what's under it (tree.js).
    const state = (a) => treeStatus(ownStatus(a.status, a.address, all), kids.get(a.address));
    const running = (a) => state(a) === "working";
    // Pins are the agents list's (t3-agents), one set for both: pinned agents stay up top in pin order, whatever their state.
    const pins = shared("agents.pins") ?? [];
    // When a snooze ends (0: none). Past it, the label stays as "woke, not looked at yet".
    const napUntil = (a) => Number(this.pending.snoozed[a.address] ?? term.get(a.address)?.labels?.snoozed) || 0;
    const wake = (a, cx) => this.setLabel("snoozed", a.address, "", cx);
    // A snooze ends on a failure in its tree (a program's error doesn't stay said), a new turn in view (the person gave
    // it work), a pin, or being looked at once it has woken.
    const failed = (a) => term.get(a.address)?.status === "error" || descendants(all, a.address).some((k) => k.status === "error");
    const pinnedNow = new Set(pins);
    for (const a of every) {
      const until = napUntil(a);
      if (!until) continue;
      const turned = viewing(a) && running(a) && ["idle", "done"].includes(this.changed[a.address]?.s);
      if (failed(a) || turned || (viewing(a) && until <= now) || (this.pinsSeen && pinnedNow.has(a.address) && !this.pinsSeen.has(a.address))) this.setLabelDue("snoozed", a.address, "", cx);
    }
    this.pinsSeen = pinnedNow;
    // Out of sight until then, unless it needs the person.
    const hidden = (a) => !settledAt(a) && napUntil(a) > now && state(a) !== "blocked";
    const woke = (a) => napUntil(a) > 0 && napUntil(a) <= now;
    this.track(every.map((a) => ({
      address: a.address, s: state(a) === "blocked" ? "blocked" : running(a) ? "working"
        : state(a) === "done" && kids.get(a.address).includes("working") ? "done" : "idle",
      turn: term.get(a.address)?.turn ?? 0, excluded: pins.includes(a.address) || Boolean(settledAt(a)) || hidden(a),
      // A mod pane first seen is one just opened.
      first: a.mod ? now : 0,
    })), all, now, cx);
    const mark = (a) => this.changed[a.address];
    // Seen changing, then; before that, the core's time of its last change. terminals() only has that as of
    // the app's start (status_ms isn't updated live), so it serves only until we see a change ourselves.
    const since = (a) => mark(a)?.at || term.get(a.address)?.status_ms || 0;
    // Just stopped: it shows its state now but keeps its Working place until the grace is out.
    const lingering = (a) => mark(a)?.s === "idle" && mark(a).start != null;
    // T3's Working shelf.
    const working = (a) => running(a) || lingering(a);
    // Active by when each came back to the person; Working by when its run started.
    const newest = (x, y) => since(y) - since(x) || byAddress(x, y);
    const begun = (a) => (lingering(a) ? mark(a).start || term.get(a.address)?.status_ms || 0 : since(a));
    // Working since: seen set going; before that, its own report, or for a parent waiting on sub-agents the
    // longest-working one's.
    const started = (a) => mark(a)?.at || (a.status === "working" ? term.get(a.address)?.status_ms
      : Math.min(Infinity, ...descendants(all, a.address).filter((k) => kidStatus(k, listed) === "working").map((k) => k.status_ms).filter(Boolean)));
    // FLAT (local change): one list, no Pinned / Working / Snoozed / Settled. Newest finish first: a finished agent
    // goes by when it stopped; a working one keeps the place of its last finish (kept in localStorage "done-at"),
    // else of its start, and moves up when it stops.
    if (FLAT) {
      let wrote = false;
      for (const a of every) if (!running(a) && since(a) && this.doneAt[a.address] !== since(a)) { this.doneAt[a.address] = since(a); wrote = true; }
      if (wrote) {
        for (const k of Object.keys(this.doneAt)) if (!term.has(k) && !every.some((a) => a.address === k)) delete this.doneAt[k];
        localStorage.setItem("done-at", JSON.stringify(this.doneAt));
      }
    }
    const doneAt = (a) => running(a) ? this.doneAt[a.address] ?? begun(a) : since(a);
    const pinned = FLAT ? [] : pins.map((p) => list.find((a) => a.address === p)).filter((a) => a && !hidden(a));
    const rest = list.filter((a) => FLAT || !pins.includes(a.address));
    const out = FLAT ? [...list].sort((x, y) => doneAt(y) - doneAt(x) || byAddress(x, y))
      : rest.filter((a) => !settledAt(a) && !hidden(a) && !working(a)).sort(newest);
    const work = FLAT ? [] : rest.filter((a) => !settledAt(a) && !hidden(a) && working(a)).sort((x, y) => begun(y) - begun(x) || byAddress(x, y));
    // Soonest back first; pinned ones too: they wake back to their pin.
    const nap = FLAT ? [] : list.filter(hidden).sort((x, y) => napUntil(x) - napUntil(y) || byAddress(x, y));
    const put = FLAT ? [] : rest.filter(settledAt).sort((x, y) => settledAt(y)[0] - settledAt(x)[0] || byAddress(x, y));
    // Shelves fold by default on this screen; the one in view stays out even folded or past the page, so it's never lost.
    const busyRows = this.workOpen ? work : work.filter(viewing);
    const napRows = this.napOpen ? nap : nap.filter(viewing);
    // A menu whose card went (snoozed, gone) or now needs the person closes, as T3's.
    if (this.napMenu && ![...pinned, ...out, ...busyRows].some((a) => a.address === this.napMenu && state(a) !== "blocked")) this.napMenu = null;
    // Back on time: the next wake redraws (the minute tick would be up to a minute late).
    const next = Math.min(Infinity, ...every.filter(hidden).map(napUntil));
    if (next !== this.nextWake) {
      this.wakeTimer?.cancel();
      this.nextWake = next;
      this.wakeTimer = next < Infinity ? cx.timer.after(Math.min(next - now, DAY), (cx) => { this.nextWake = null; cx.notify(); }) : null;
    }
    // agent.next goes as the list reads. Only while this list shows: the agents list (t3-agents) sets its own.
    const find = (n) => n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(find).find(Boolean);
    if (find(layout())?.active !== "lists") setAgentOrder([...pinned, ...out, ...work, ...nap, ...put].filter((a) => !a.mod).map((a) => a.address));

    const title = namer();
    // Local change: a click quiets its card (`this.quiet`) until the pointer really leaves it or reaches another row.
    // The redraw after a click can report the pointer entering the same row again, which reopened the card at once.
    const hover = (a) => (on, cx) => {
      const q = this.quiet;
      if (on) {
        this.hovered = a.address;
        if (q && q.key !== a.address) this.quiet = null;
        if (!this.quiet) this.detailsFor(a.address, cx);
      } else if (this.hovered === a.address) {
        this.hovered = null;
        if (q?.key === a.address && Date.now() - q.at > 300) this.quiet = null;
        this.detailsFor(null, cx);
      }
      cx.notify();
    };
    const hush = (a, cx) => {
      this.quiet = { key: a.address, at: Date.now() };
      this.detailsFor(null, cx);
    };
    // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state.
    const glow = (id) => (on, cx) => {
      if (on) this.hot = id;
      else if (this.hot === id) this.hot = null;
      cx.notify();
    };
    const lit = (id, color) => (this.hot === id ? t.foreground : color);
    // A space's mark, as t3-spaces draws it.
    const avatar = (id, name, size) => projectMark(sp.find((s) => s.id === id) ?? { name: name ?? "" }, size, t, ps);
    // Brought back, it's news again: the top of the list.
    const unsettle = (a, cx) => {
      this.setLabel("settled", a.address, "", cx);
      this.changed[a.address] = { ...this.changed[a.address], at: Date.now(), start: null };
      localStorage.setItem("changes", JSON.stringify(this.changed));
    };
    const go = (a) => a.mod || a.lost ? run("pane.focus", { pane: a.pane }) : run("agent.focus", { terminal: a.address });
    // Putting away the agent in view moves on to the next card down the list, from the top past the end, as T3 does;
    // one in the background moves nothing.
    const moveOn = (xs) => {
      const cards = [...pinned, ...out, ...busyRows], i = cards.findIndex(viewing);
      if (i < 0 || !xs.includes(cards[i])) return false;
      const next = [...cards.slice(i + 1), ...cards.slice(0, i)].find((a) => !xs.includes(a));
      if (next) go(next);
      return Boolean(next);
    };
    // Settling ends a snooze and a pin, as T3's. A mod pane closes, once the view has moved on from it.
    const settle = (xs, cx) => {
      const panes = xs.filter((a) => a.mod), kept = xs.filter((a) => !a.mod);
      const naps = new Map(kept.map((a) => [a, napUntil(a)]));
      const before = [...pins], unpinned = pins.filter((p) => !kept.some((a) => a.address === p));
      if (unpinned.length < before.length) setShared("agents.pins", unpinned);
      for (const a of kept) {
        this.setLabel("settled", a.address, `${Date.now()}:${term.get(a.address)?.turn ?? 0}`, cx);
        if (naps.get(a)) wake(a, cx);
      }
      // Undone, they're back where they were: no news, as T3 restores a thread, with its pin and a snooze that hasn't
      // run out. A pin coming back isn't a new pin, which would wake that snooze.
      if (kept.length) this.remember("Settled", kept.length, (cx) => {
        if (unpinned.length < before.length) {
          setShared("agents.pins", before);
          for (const a of kept) this.pinsSeen.add(a.address);
        }
        for (const a of kept) {
          this.setLabel("settled", a.address, "", cx);
          if (naps.get(a) > Date.now()) this.setLabel("snoozed", a.address, String(naps.get(a)), cx);
        }
      }, cx);
      const moved = moveOn(xs);
      for (const a of panes) run("pane.close", { pane: a.pane });
      return moved;
    };
    const snooze = (a, at, cx) => {
      this.setLabel("snoozed", a.address, String(at), cx);
      this.remember("Snoozed", 1, (cx) => wake(a, cx), cx);
      // The card moves away without a pointer-leave event, for it or for the clock under the pointer.
      this.napMenu = this.hovered = this.hot = null;
      this.detailsFor(null, cx);
      moveOn([a]);
    };
    // As T3's pick: a duration counts from the click; a time that passed since the menu was drawn is refused.
    const pick = (a, p, cx) => {
      if (p.custom) {
        // A dialog over the card hides the pointer's leaving it.
        this.napMenu = this.hovered = this.hot = null;
        this.detailsFor(null, cx);
        openOverlay({ mod: "t3-inbox", kind: "dialog", width: 384, height: 310, props: { customSnooze: a.address } });
        return;
      }
      const at = p.hours ? Date.now() + p.hours * 3600000 : p.at;
      if (at > Date.now()) return snooze(a, at, cx);
      this.napAt = -1;
      notify({ title: "Couldn't snooze the agent", body: "That time has passed. Choose another.", level: "warning" });
    };
    // The Custom dialog leaves its answer in shared. By then it may have come to need the person, which T3 refuses too.
    this.customSnooze = (cx) => {
      const c = shared("t3-inbox.custom");
      if (!c) return;
      setShared("t3-inbox.custom", null);
      const a = every.find((x) => x.address === c.address);
      if (a && state(a) !== "blocked" && c.at > Date.now()) snooze(a, c.at, cx);
    };
    // The settle key: the agent in view, as its card's Settle (finished) or its settled row's undo.
    this.settleKey = (cx) => {
      const a = every.find(viewing);
      if (!a) return;
      if (settledAt(a)) unsettle(a, cx);
      else if (!busy(a)) settle([a], cx);
    };

    // Dragging, as T3's sidebar does it (Sidebar.drag.ts, Sidebar.pointer.ts). Press a row and move 6px to lift it;
    // it follows the pointer up and down inside the list and says what letting go will do. While it's lifted, the
    // Pinned and Active labels open, and the list opens a gap the size of the destination's row where it will
    // land. Pinned keeps a hand-made order; Active and Settled keep their own, so the gap opens where that puts it.
    let d = this.drag;
    // A row that leaves the list (its agent ended, a filter) can't be dropped. Render can't run commands, so
    // `this.back` stays and the release (or Esc, or leaving) hands the keyboard back.
    if (d && !list.some((a) => a.address === d.from)) d = this.drag = null;
    const dragging = Boolean(d?.moved);
    const lifted = dragging ? list.find((a) => a.address === d.from) : null;
    const sectionOf = (a) => hidden(a) ? "snoozed" : pins.includes(a.address) ? "pinned" : settledAt(a) ? "settled" : working(a) ? "working" : "active";
    const from = lifted ? sectionOf(lifted) : null;
    const fromShelf = from === "settled" || from === "snoozed";
    const others = (xs) => xs.filter((x) => x.address !== d?.from);
    const pinTo = (before) => ({ section: "pinned", before: before ?? null });
    const pinOrder = (before) => {
      const kept = pins.filter((p) => p !== d.from), at = before ? kept.indexOf(before) : -1;
      kept.splice(at < 0 ? kept.length : at, 0, d.from);
      return kept;
    };
    // What letting go would do, and the gap that shows it: above a row (its address), after a section's last row
    // (`end-…`), right under an empty section's label (`head-…`), or none (a folded or busy destination).
    const plan = (() => {
      const to = lifted && d.target;
      if (!to || (to.section === from && from !== "pinned")) return null;
      if (to.section === "pinned") {
        const order = pinOrder(to.before);
        if (from === "pinned" && order.join("\n") === pins.join("\n")) return null;
        return { section: "pinned", order, gap: to.before ?? (others(pinned).length ? "end-pinned" : "head-pinned") };
      }
      // Busy work can't be settled (new work brings it straight back); out of Pinned it joins the Working shelf.
      if (busy(lifted)) return to.section === "settled" ? null : { section: "active", gap: null };
      if (to.section === "settled") return { section: "settled", gap: !this.open ? null : others(put)[0]?.address ?? "head-settled" };
      const rest = others(out), at = from === "settled" ? 0 : rest.filter((x) => newest(x, lifted) < 0).length;
      return { section: "active", gap: !rest.length ? "head-active" : rest[at]?.address ?? "end-active" };
    })();
    const target = dragging ? d.target?.section ?? null : null;
    // A section lights up as the target, as T3's labels and shelf header do.
    const hot = (s) => target === s && (Boolean(plan) || s === from);
    const verb = !plan ? null : plan.section === "pinned" ? (from === "pinned" ? null : "pin")
      : plan.section === "settled" ? "settle" : from === "pinned" ? "unpin" : from === "settled" ? "unsettle" : from === "snoozed" ? "wake" : null;
    const BADGE = { pin: ["mods/workspace-chrome/pin.svg", "Pin"], unpin: ["mods/workspace-chrome/pin-off.svg", "Unpin"],
      settle: ["mods/workspace-chrome/circle-check.svg", "Settle"], unsettle: ["mods/t3-inbox/undo.svg", "Un-settle"], wake: ["mods/t3-inbox/alarm-clock-off.svg", "Wake"] };
    const badge = (v) => h_flex().id(`badge-${v}`).h(20).px(6).gap(4).flex_none().items_center().rounded(4)
      .border(1).border_color(t.accent + "66").bg(t.accent + "1a").text_size(11).font_medium().text_color(t.accent)
      .child(svg(BADGE[v][0]).size(12).flex_none().text_color(t.accent)).child(BADGE[v][1]);

    // Settled shows one page; while a drag moves a row out of it the next row fills in, and one settled into
    // it pushes the page's last row out of sight.
    const fromPage = from === "settled" && put.indexOf(lifted) < this.limit;
    const size = this.limit + (fromPage && plan ? 1 : 0) - (plan?.section === "settled" && from !== "settled" ? 1 : 0);
    const page = this.open ? put.slice(0, size) : [];
    const rows = [...page, ...put.filter((a) => viewing(a) && !page.includes(a))];
    // What the next and previous keys walk (t3-chrome): the rows drawn, in order, and the one in view. Written only when
    // it changes: every write redraws every mod.
    const drawn = { order: [...pinned, ...out, ...busyRows, ...napRows, ...rows].map((a) => a.address), view: inView };
    if (JSON.stringify(drawn) !== JSON.stringify(shared("t3-inbox.rows") ?? null)) setShared("t3-inbox.rows", drawn);

    const aim = (to, cx) => {
      if (!this.drag?.moved || JSON.stringify(this.drag.target ?? null) === JSON.stringify(to)) return;
      this.drag.target = to;
      cx.notify();
    };
    // Over a pin, the upper half drops above it and the lower half below.
    const pinNear = (a, upper) => {
      const xs = pinned.map((x) => x.address), i = xs.indexOf(a.address);
      return pinTo(xs.slice(upper && a.address !== d?.from ? i : i + 1).find((x) => x !== d?.from));
    };
    // The gap: a card and the list's 2px in Pinned and Active, a 30px slim row in Settled (stacked without gaps).
    const MOTION = { duration: 150, easing: "ease-out" };
    const cardH = lifted && !fromShelf ? d.height : this.cardH ?? 82;
    const gap = (key) => div().id(`gap-${key}`).flex_none().h(plan?.gap !== key ? 0 : plan.section === "settled" ? 30 : cardH + 2)
      .when(dragging, (el) => el.transition("height", MOTION));
    // Each droppable row sits in a lane: the gap that opens above it, the row (folding away once the lifted one is
    // headed elsewhere, holding its place until then) with the list's spacing, and after the last, the end gap.
    const lane = (section, xs, draw, spacing) => xs.map((a, i) => v_flex().id(`lane-${a.address}`).flex_none()
      .child(gap(a.address))
      .child(v_flex().id(`hold-${a.address}`).flex_none()
        .when(dragging && d.from === a.address, (el) => el.overflow_hidden().opacity(0).h(plan ? 0 : d.height + spacing).transition("height", MOTION))
        .child(fly(a.address, section === "settled" || section === "snoozed" ? "slim" : "card", draw(a))).when(spacing > 0, (el) => el.child(div().h(spacing).flex_none())))
      .when(i === xs.length - 1, (el) => el.child(gap(`end-${section}`))));
    // T3's boundaries: Pinned and Active labels, shown only while dragging; the list opens room for them.
    const boundary = (id, text, section, to) => h_flex().id(id).flex_none().overflow_hidden().h(dragging ? 24 : 0)
      .transition("height", MOTION).px(10).gap(8).items_center().text_size(12).font_medium()
      .on_mouse_move((_e, cx) => aim(to, cx))
      .when(dragging, (el) => el.child(div().text_color(hot(section) ? t.accent : t.muted).child(text))
        .child(div().flex_1().h(1).bg(hot(section) ? t.accent + "80" : t.border)));
    // An empty section still takes a drop: T3's dashed placeholder, accent while it's the target.
    const placeholder = (section, text) => div().id(`${section}-placeholder`).h(36).mb(2).flex_none().flex().items_center().justify_center()
      .rounded(6).border(1).border_dashed().text_size(12)
      .border_color(hot(section) ? t.accent + "66" : t.border).text_color(hot(section) ? t.accent : t.muted)
      .when(hot(section), (el) => el.bg(t.accent + "0d"))
      .on_mouse_move((_e, cx) => aim({ section }, cx))
      .child(text);
    // Picked up anywhere on a row that can move (not Working, not one whose change is still on its way). The clock's
    // Popover hears its own press, so the row just leaves it alone.
    const row = (el, a) => el.relative()
      // Up from the hover on: a Popup must have measured its anchor before the frame a card starts to fade in.
      .when([this.hovered, this.details, this.detailsOut].includes(a.address), (r) => r.child(details(a)))
      .on_mouse_down("left", (e) => {
        if (FLAT || a.mod || sectionOf(a) === "working" || this.pending.settled[a.address] !== undefined || this.pending.snoozed[a.address] !== undefined || this.hot === `snooze-${a.address}`) return;
        this.drag = { from: a.address, at: e.position, grab: e.local_position?.y ?? 0, height: e.bounds?.height ?? 0, moved: false, target: null };
      })
      .on_mouse_move((e, cx) => {
        if (this.sweep?.moved) return sweepTo(a, cx);
        const s = sectionOf(a);
        // Nothing lands in Snoozed: a drop can't say when it wakes, as T3's.
        aim(s === "pinned" ? pinNear(a, (e.local_position?.y ?? 0) < (e.bounds?.height ?? 0) / 2) : s === "working" || s === "snoozed" ? null : { section: s }, cx);
      });
    // A drag's or sweep's release doesn't also click the row or button it ends on.
    const justDropped = () => this.drag?.moved || this.sweep?.moved || Date.now() - (this.dropped ?? 0) < 250;
    const open = (a) => (_e, cx) => {
      if (justDropped() || this.hot === `snooze-${a.address}`) return;
      go(a);
      // As a T3 tooltip, a click takes its card down until the pointer comes back.
      hush(a, cx);
      cx.notify();
    };
    // Says whether it moved on to another agent.
    const drop = (cx) => {
      if (!plan) return false;
      const a = lifted;
      if (plan.section === "settled") return settle([a], cx);
      if (plan.section === "pinned") setShared("agents.pins", plan.order);
      else if (pins.includes(a.address)) {
        const before = [...pins];
        setShared("agents.pins", pins.filter((p) => p !== a.address));
        this.remember("Unpinned", 1, () => setShared("agents.pins", before), cx);
      }
      if (settledAt(a)) unsettle(a, cx);
      if (napUntil(a)) wake(a, cx);
      return false;
    };

    // Sweep, T3's other drag: press a card's Settle (or a settled row's undo) and move across rows to take the
    // whole run along; letting go settles (or brings back) every row it marked.
    const sweepFrom = (action, a) => (e, cx) => {
      cx.stop_propagation();
      this.sweep = { action, origin: a.address, at: e.position, moved: false, keys: [a.address] };
    };
    // Within the section it started in, as T3's.
    const sweepList = () => this.sweep.action === "settle" ? (pins.includes(this.sweep.origin) ? pinned : out).filter((x) => !busy(x) && !x.mod) : this.sweep.action === "unsnooze" ? napRows : rows;
    const sweepTo = (a, cx) => {
      const xs = sweepList().map((x) => x.address), i = xs.indexOf(this.sweep.origin), j = xs.indexOf(a.address);
      if (i < 0 || j < 0) return;
      const keys = xs.slice(Math.min(i, j), Math.max(i, j) + 1);
      if (keys.join("\n") === this.sweep.keys.join("\n")) return;
      this.sweep.keys = keys;
      cx.notify();
    };
    const swept = (a) => Boolean(this.sweep?.moved && this.sweep.keys.includes(a.address));
    const finish = (cx) => {
      if (!this.drag && !this.sweep && !this.back) return;
      const moved = (dragging && drop(cx)) || (Boolean(this.sweep?.moved) && applySweep(cx));
      if (dragging && moved) this.landed = { key: d.from, y: ghostTop() - TOP };
      if (dragging || this.sweep?.moved) this.dropped = Date.now();
      this.endDrag(!moved);
    };
    const applySweep = (cx) => {
      const xs = sweepList().filter((x) => this.sweep.keys.includes(x.address));
      if (this.sweep.action === "settle") return settle(xs, cx);
      for (const a of xs) this.sweep.action === "unsnooze" ? wake(a, cx) : unsettle(a, cx);
      return false;
    };

    // A control's label in a row belongs to the same group as the row's card, so it too opens at once.
    const delay = this.detailsLive() ? 0 : 150;
    const machineOf = (a) => a.address.includes("/") ? a.address.split("/")[0] : null;
    const branchOf = (a) => ps.find((p) => p.pane === a.pane)?.branch;
    // Local change: commits to push and pull for the card's folder, as t3-spaces counts them. Read again after 20s
    // when a render asks (the minute tick, any change); read-only git, no optional locks.
    const syncOf = (a) => {
      const cwd = ps.find((p) => p.pane === a.pane)?.cwd;
      if (!cwd || a.mod) return null;
      const on = sp.find((s) => s.id === a.space)?.machine ?? null;
      const key = JSON.stringify([on, cwd]), v = this.sync[key];
      if ((!v || now - v.at > 20000) && !this.syncing.has(key)) {
        this.syncing.add(key);
        cx.spawn(async (cx) => {
          let ahead = 0, behind = 0;
          try {
            const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on });
            if (r.code === 0) [ahead, behind] = r.stdout.trim().split(/\s+/).map((x) => Number(x) || 0);
          } catch {}
          const old = this.sync[key];
          this.sync[key] = { ahead, behind, at: Date.now() };
          this.syncing.delete(key);
          if (!old || old.ahead !== ahead || old.behind !== behind) cx.notify();
        });
      }
      return v ?? null;
    };
    // A row's details, as T3's thread card: on the row's right from its top. A 1px anchor just outside its top right corner, as
    // a Popup hangs from its trigger's bottom left; clamped at the window's bottom the card slides up and still clears the row.
    // A control lit in the row speaks for itself instead, as T3's group lets one tooltip up at a time.
    const details = (a) => {
      const machine = machineOf(a), branch = branchOf(a), pic = icon(a.program, 12, t.muted);
      const up = this.details === a.address || this.detailsOut === a.address;
      return Popup.new(`details-${a.address}`, div()).absolute().top(-1).right(-1).size(1)
        .when(up && !this.hot && !this.napMenu && !dragging && !this.sweep?.moved, (pop) => pop.content(detailsCard(this, t, a.address, title(a), [
          a.space_name && detailsLine(t, avatar(a.space, a.space_name, 12), a.space_name),
          machine && detailsLine(t, svg("mods/workspace-chrome/server.svg").size(12).flex_none().text_color(t.muted), machine),
          branch && detailsLine(t, svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.muted), branch),
          pic && detailsLine(t, div().flex_none().opacity(0.6).child(pic), a.program.name),
        ]).ml(4)));
    };

    // `ghost`: the copy that follows the pointer, drawn without handlers or ids the list already uses.
    // A card's live sub-agents, all the way down, with the tree lines to draw before each, as t3-agents' tree().
    const kidTree = (addr, lead = []) => {
      const ks = all.filter((k) => k.parent === addr && k.state === "live");
      return ks.flatMap((k, i) => {
        const last = i === ks.length - 1;
        return [{ t: k, depth: lead.length + 1, lines: [...lead, last ? "└" : "├"] }, ...kidTree(k.address, [...lead, last ? "" : "│"])];
      });
    };
    const kidsOpen = (a) => !this.kidsFolded.includes(a.address);
    // The fold arrow on the card's third line; folded, the count.
    const foldKids = (a, tree) => {
      const open = kidsOpen(a), id = `kids-${a.address}`;
      return tip(this.hot, t, id, open ? "Collapse sub-agents" : "Expand sub-agents", h_flex().id(id).h(16).gap(2).flex_none().items_center().rounded(4)
        .role("button").accessibility_label(open ? "Collapse sub-agents" : "Expand sub-agents").on_hover(glow(id))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.kidsFolded = open ? [...this.kidsFolded, a.address] : this.kidsFolded.filter((x) => x !== a.address);
          // Only cards still here are kept.
          this.kidsFolded = this.kidsFolded.filter((x) => term.has(x));
          localStorage.setItem("kids-folded", JSON.stringify(this.kidsFolded));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(lit(id, t.dim))), { delay });
    };
    // One sub-agent: its tree lines, program icon, name and state, 22px; a click peeks at it, as t3-agents.
    // Over a sub-agent the card's details step aside (a lit control speaks for itself); its click takes them down, or
    // they'd cover the peek it opens.
    const kidRow = (s, a) => {
      const k = s.t, st = kidStatus(k, listed), pic = icon(k.program, 12, t.muted);
      const on = k.address === (f?.agent ?? f?.terminal);
      const name = k.name || k.template || k.program?.name || k.address;
      const mark = st === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
        : st === "blocked" ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
        : div().size(7).mx(3.5).flex_none().rounded_full().border(1.5).border_color(t.idle ?? t.dim);
      // Each ancestor's line hangs from its icon's center (the card's avatar at 8px, then every 14px).
      return h_flex().id(`kid-${k.address}`).relative().h(22).pl(s.depth * 14).pr(2).gap(6).flex_none().items_center().rounded(6)
        .text_size(12).role("button").accessibility_label(name)
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((x) => x.bg(t.selected)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_hover(glow(`kid-${k.address}`))
        .on_click((_e, cx) => { cx.stop_propagation(); hush(a, cx); run("terminal.peek", { terminal: k.address }); cx.notify(); })
        .children(s.lines.flatMap((l, j) => [
          l === "│" || l === "├" ? div().absolute().left(7.25 + 14 * j).top(0).bottom(0).w(1.5).bg(t.input) : null,
          l === "├" || l === "└" ? div().absolute().left(7.25 + 14 * j).top(-4).h(15).w(6.75).border_l(1.5).border_b(1.5).rounded_bl(5).border_color(t.input) : null,
        ].filter(Boolean)))
        .child(h_flex().size(14).flex_none().items_center().justify_center().when(Boolean(pic), (el) => el.child(div().opacity(0.6).child(pic))))
        .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(name))
        .child(h_flex().size(16).flex_none().items_center().justify_end().child(mark));
    };

    const card = (a, ghost) => {
      const st = state(a), on = viewing(a);
      const machine = machineOf(a), branch = branchOf(a);
      const going = (kids.get(a.address) ?? []).filter((s) => s === "working").length;
      const tree = ghost || a.mod ? [] : kidTree(a.address);
      const sync = ghost ? null : syncOf(a), syncs = (sync?.ahead ?? 0) + (sync?.behind ?? 0) > 0;
      const meta = [branch, going ? `${going} sub-agent${going > 1 ? "s" : ""} working` : null].filter(Boolean).join(" · ");
      const pic = icon(a.program, 16, t.muted);
      const over = !dragging && !this.sweep?.moved && this.hovered === a.address;
      // As T3's rows: what you're on or what wants you leads; the rest recede until hovered, in color only so nothing reflows.
      const leads = on || ghost || st === "blocked" || st === "done" || woke(a);
      const marks = machine || pic ? h_flex().gap(4).flex_none().items_center()
        // Another machine's agent, as in T3: a server mark before its program, the machine named on hover.
        .when(Boolean(machine), (el) => {
          const server = div().when(!ghost, (m) => m.id(`machine-${a.address}`).on_hover(glow(`machine-${a.address}`)).accessibility_label(`On ${machine}`))
            .flex_none().child(svg("mods/workspace-chrome/server.svg").size(14).text_color(t.dim));
          return el.child(ghost ? server : tip(this.hot, t, `machine-${a.address}`, machine, server, { delay }));
        })
        .when(Boolean(pic), (el) => el.child(div().flex_none().opacity(0.6).child(pic))) : null;
      // Hovered, the corner offers Settle, but only for what's finished: a working or stuck tree stays in sight.
      const offer = !FLAT && over && !busy(a);
      const id = `settle-${a.address}`;
      // Snooze is offered beside it for anything not needing the person, working too, as T3's. A failed turn counts as
      // needing them here, and a mod pane has no terminal to hold the label. With its menu open the controls stay, though
      // the pointer has left the card.
      const canNap = !FLAT && !ghost && !a.mod && st !== "blocked", menu = canNap && this.napMenu === a.address, napOffer = canNap && (over || menu);
      const napId = `snooze-${a.address}`;
      // As in T3, the corner says the state when there's one worth saying (Working, Needs you, Done: finished
      // and not yet seen), else how long ago it last changed. Sized as T3's: 16px mark, 4px gaps, and the
      // time in monospace children, one per part, so spacing and width don't hang on the interface font and
      // a monospace space (a full cell) doesn't open "1h 5m" wider than the 4px gaps.
      const pill = (color, mark, label, time) => h_flex().id(`state-${a.address}`).h(20).gap(4).flex_none().items_center().font_medium().text_color(color)
        .child(mark).child(div().child(label))
        .when(Boolean(time), (el) => el.children(time.split(" ").map((part) => div().font_family(settings().font_family ?? "JetBrains Mono").child(part))));
      // It wakes where it was, so this carries the weight, as T3's; a click dismisses it, and it stays on hover.
      const wokeMark = woke(a) && tip(this.hot, t, `woke-${a.address}`, "Dismiss Woke notification", h_flex().id(`woke-${a.address}`).h(20).gap(4).flex_none().items_center().font_medium().text_color(t.blocked)
        .hover((s) => s.underline()).on_hover(glow(`woke-${a.address}`)).role("button").accessibility_label("Dismiss Woke notification")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.hot = null; // It goes, before the pointer can report leaving it.
          wake(a, cx);
          cx.notify();
        })
        .child(svg("mods/t3-inbox/alarm-clock.svg").size(16).flex_none().text_color(t.blocked)).child("Woke"), { delay });
      const acting = offer || napOffer, quiet = acting && (menu || !woke(a));
      // Lifted, or marked by a sweep, the corner says what letting go will do instead.
      // The state or the time, faded out on hover where Settle fades in over it, as T3's corner.
      const word = running(a)
          ? pill(t.working, svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.working).spin(900),
            "Working", started(a) > 0 && started(a) < Infinity ? took(started(a), now) : null)
          : st === "blocked"
            ? pill(t.blocked, div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().flex().items_center().justify_center().child("!"), "Needs you")
            : wokeMark
              || (st === "done"
                ? pill(t.ansi2, svg("mods/workspace-chrome/circle-check.svg").size(16).flex_none().text_color(t.ansi2), "Done")
                : div().id(`state-${a.address}`).flex_none().child(since(a) > 0 ? ago(since(a), now) : ""));
      // Still at work when it wakes, it says both, as T3's row; hovered, Woke stays and Working makes way.
      const status = running(a) && wokeMark ? h_flex().gap(4).flex_none().items_center().when(!acting, (el) => el.child(word)).child(wokeMark) : word;
      // Hangs from the clock's left edge and out over the sidebar's edge, as T3's: the card stays readable.
      const clock = canNap && tip(menu ? null : this.hot, t, napId, "Snooze agent", Popover.new(`snooze-menu-${a.address}`).anchor("top_left").open(menu).track_focus(this.napKeys)
        .on_open_change((open, cx) => {
          this.napMenu = open ? a.address : null;
          this.napAt = -1;
          // Enter and Space are the Popover's, which would only close it: a binding of ours, deeper in, comes first.
          // On each open, as win98's menu binds: a reload of keys.json clears the keymap.
          if (open) cx.bind_keys(["enter", "space"].map((keystroke) => ({ keystroke, action: "t3_inbox_snooze_pick", context: "InboxSnoozeMenu" })));
          cx.notify();
        })
        .trigger(h_flex().id(napId).size(20).flex_none().items_center().justify_center().rounded(4)
          .opacity(napOffer ? 1 : 0).transition("opacity", MOTION).when(menu, (el) => el.bg(t.hover)).on_hover(glow(napId))
          .role("button").accessibility_label("Snooze agent")
          .child(svg("mods/workspace-chrome/clock.svg").size(12).flex_none().text_color(menu ? t.foreground : lit(napId, t.muted))))
        .when(menu, (el) => {
          const choices = [...presets(now), { label: "Custom…", custom: true }];
          // Sized as T3's menu: as wide as its rows, 160px at least. Nothing lit until the pointer or a key gets there.
          return el.content(v_flex().id(`snooze-panel-${a.address}`).min_w(160).mt(4).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(14)
            .track_focus(this.napKeys).key_context("InboxSnoozeMenu")
            .on_action("t3_inbox_snooze_pick", (_e, cx) => {
              if (choices[this.napAt]) pick(a, choices[this.napAt], cx);
              cx.notify();
            })
            .on_key_down((e, cx) => {
              if (e.key !== "down" && e.key !== "up") return;
              const n = choices.length;
              this.napAt = e.key === "down" ? (this.napAt + 1) % n : (this.napAt <= 0 ? n : this.napAt) - 1;
              cx.stop_propagation();
              cx.notify();
            })
            .children(choices.flatMap((p, i) => [
              ...(p.custom ? [div().h(1).mx(8).my(4).flex_none().bg(t.border)] : []),
              h_flex().id(`snooze-${i}-${a.address}`).h(28).px(8).gap(8).flex_none().items_center().rounded(4)
                .when(i === this.napAt, (row) => row.bg(t.selected))
                .on_hover((on, cx) => {
                  const at = on ? i : this.napAt === i ? -1 : this.napAt;
                  if (at !== this.napAt) { this.napAt = at; cx.notify(); }
                })
                .role("button").accessibility_label(p.label)
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  pick(a, p, cx);
                  cx.notify();
                })
                .child(div().flex_none().text_color(t.foreground).child(p.label))
                .when(Boolean(p.when), (row) => row.child(div().flex_none().ml_auto().text_size(12).font_medium().text_color(t.dim).child(p.when))),
            ])));
        }), { delay });
      const corner = ghost ? (verb ? badge(verb) : div())
        : swept(a) ? badge("settle")
        // As T3's corner: hovered, the controls take the slot and the state fades out from under them, but for Woke.
        : h_flex().id(`corner-${a.address}`).relative().h(20).min_w(20).gap(4).flex_none().items_center().justify_end()
          .child(div().flex_none().when(quiet, (el) => el.absolute().top(0).right(0)).opacity(quiet ? 0 : 1).transition("opacity", MOTION).child(status))
          .child(h_flex().id(`controls-${a.address}`).h(20).gap(4).flex_none().items_center().when(!acting, (el) => el.absolute().top(0).right(0))
          .when(Boolean(clock), (el) => el.child(clock))
          .child(div().when(!offer, (el) => el.absolute().top(0).right(0)).child(tip(this.hot, t, id, a.mod ? "Settle and close" : "Settle agent", h_flex().id(id).h(20).px(6).gap(4).flex_none().items_center().rounded(4)
          .text_size(12).text_color(lit(id, t.muted)).opacity(offer ? 1 : 0).transition("opacity", MOTION)
          // Faded out it's no button: a click there is the card's.
          .when(offer, (el) => el.on_hover(glow(id)).role("button").accessibility_label(a.mod ? "Settle and close" : "Settle").when(!a.mod, (b) => b.on_mouse_down("left", sweepFrom("settle", a))).on_click((_e, cx) => {
            cx.stop_propagation();
            if (justDropped()) return;
            // A click is no sweep. Its release stops here, so the sidebar's mouse-up won't end the one the press began.
            this.sweep = null;
            // The card moves away without a pointer-leave event.
            this.hovered = null;
            this.detailsFor(null, cx);
            settle([a], cx);
            cx.notify();
          }))
          .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(lit(id, t.muted)))
          .child("Settle"), { action: "t3-inbox.settle", delay }))));
      const base = v_flex().id(`${ghost ? "ghost-" : ""}card-${a.address}`).px(10).py(8).gap(2).flex_none().rounded(10)
        // A working row recedes until it's hovered or in view, as T3's.
        .when(!ghost, (el) => el.opacity(running(a) && !woke(a) && !on && !over ? 0.7 : 1).transition("opacity", MOTION));
      return (ghost ? base : row(base, a).role("button").accessibility_label(title(a)).on_hover(hover(a))
        .on_click(open(a)).on_size_change((size) => { this.cardH = size.height; })
        // Local change: right-click opens the card's menu (cardMenuItems); its details card steps aside.
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          if (this.drag || this.sweep) return;
          hush(a, cx);
          openCardMenu(a, tree.length > 0, !kidsOpen(a));
          cx.notify();
        }))
        .when(on, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        // Local change: the space leads the card (no title line): 14px medium, foreground when it leads or is hovered.
        .child(h_flex().h(22).gap(8).items_center().text_size(12).text_color(t.dim)
          .child(avatar(a.space, a.space_name, 18))
          // Lifted, a pin keeps its glyph only while it stays among the pins.
          .when(pins.includes(a.address) && (!ghost || plan?.section === "pinned" || !plan), (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.dim)))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium()
            .text_color(leads || over || swept(a) ? t.foreground : t.muted).child(a.space_name ?? ""))
          .child(corner))
        // The branch, the sub-agents and the marks.
        .when(Boolean(meta) || tree.length > 0 || Boolean(marks) || syncs, (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
          .when(tree.length > 0 && !ghost, (m) => m.child(foldKids(a, tree)))
          .child(h_flex().flex_1().min_w(0).gap(4).items_center()
            .child(div().min_w(0).truncate().child(meta || (tree.length ? `${tree.length} sub-agent${tree.length > 1 ? "s" : ""}` : "")))
            // Commits to push (green) and pull (red), after the branch, as in the Spaces list.
            .when(!ghost && (sync?.ahead ?? 0) > 0, (m) => m.child(div().flex_none().text_color(t.ansi2).child(`↑${sync.ahead}`)))
            .when(!ghost && (sync?.behind ?? 0) > 0, (m) => m.child(div().flex_none().text_color(t.ansi1).child(`↓${sync.behind}`))))
          .when(Boolean(marks), (m) => m.child(marks))))
        // Its sub-agents as a tree under it, as t3-agents draws them: open unless folded; folded, a stuck one still shows.
        .when(!ghost && tree.length > 0, (el) => {
          const shown = kidsOpen(a) ? tree : tree.filter((s) => kidStatus(s.t, listed) === "blocked")
            .map((s, j, xs) => ({ ...s, depth: 1, lines: [j === xs.length - 1 ? "└" : "├"] }));
          return shown.length ? el.child(v_flex().mt(2).children(shown.map((s) => kidRow(s, a)))) : el;
        });
    };

    // A settled or snoozed row: one dim line; viewing it leaves it so. Hovered it brightens and its time becomes a
    // bare undo arrow, or for a snoozed one, which shows when it comes back, Wake's crossed-out alarm clock, as in T3.
    const slim = (a, ghost) => {
      const on = viewing(a), over = !dragging && !this.sweep?.moved && this.hovered === a.address, bright = on || over || ghost || swept(a);
      const napping = hidden(a), undoId = `${napping ? "wake" : "unsettle"}-${a.address}`, undoLabel = napping ? "Wake agent" : "Unsettle";
      // As T3's settled rows: its project's mark, not its program's.
      const mark = avatar(a.space, a.space_name, 16);
      const undo = h_flex().id(undoId).size(20).flex_none().items_center().justify_center().rounded(4)
        .opacity(over ? 1 : 0).transition("opacity", MOTION)
        // Faded out it's no button: a click there is the row's.
        .when(over, (el) => el.on_hover(glow(undoId)).role("button").accessibility_label(undoLabel)
          .on_mouse_down("left", sweepFrom(napping ? "unsnooze" : "unsettle", a)).on_click((_e, cx) => {
          cx.stop_propagation();
          if (justDropped()) return;
          this.sweep = null;
          this.hovered = null;
          this.detailsFor(null, cx);
          if (napping) wake(a, cx); else unsettle(a, cx);
          cx.notify();
        }))
        .child(svg(`mods/t3-inbox/${napping ? "alarm-clock-off" : "undo"}.svg`).size(14).flex_none().text_color(lit(undoId, t.muted)));
      const time = napping
        ? h_flex().gap(4).items_center().text_color(t.accent).child(svg("mods/t3-inbox/alarm-clock.svg").size(12).flex_none().text_color(t.accent)).child(left(napUntil(a), now))
        : !ghost && ago(settledAt(a)[0], now);
      const base = h_flex().id(`${ghost ? "ghost-" : ""}slim-${a.address}`).h(30).px(10).gap(8).flex_none().items_center().rounded(8);
      return (ghost ? base : row(base, a).role("button").accessibility_label(title(a)).on_hover(hover(a)).on_click(open(a)))
        .when(on, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().id(`slim-mark-${a.address}`).size(16).flex_none().items_center().justify_center().opacity(bright ? 1 : 0.4).transition("opacity", MOTION).child(ghost ? mark : tipMark(this, t, `slim-space-${a.address}`, a.space_name, mark, { delay })))
        .child(div().flex_1().min_w(0).truncate().text_color(bright ? t.foreground : t.muted).child(title(a)))
        .child(ghost ? (verb ? badge(verb) : div()) : swept(a) ? badge(this.sweep.action === "unsnooze" ? "wake" : "unsettle")
          // T3's corner: the time fades out on hover as the undo arrow fades in over it.
          : h_flex().id(`slim-corner-${a.address}`).relative().h(20).min_w(20).flex_none().items_center().justify_end()
            .child(div().flex_none().text_size(12).text_color(t.dim).opacity(over ? 0 : 1).transition("opacity", MOTION).child(time))
            .child(div().absolute().top(0).right(0).child(tip(this.hot, t, undoId, undoLabel, undo, { action: napping ? undefined : "t3-inbox.settle", delay }))));
    };

    // A shelf's header, folding it: label, then count and chevron at the far edge.
    const shelf = (id, label, count, open, toggle, extra) => h_flex().id(id).h(30).px(10).gap(6).flex_none().items_center()
      .text_size(12).font_medium().text_color(t.dim)
      .role("button").accessibility_label(`${open ? "Hide" : "Show"} ${label.toLowerCase()} agents`)
      .on_click((_e, cx) => {
        toggle();
        cx.notify();
      })
      .child(div().flex_1().child(label))
      .when(Boolean(extra), (el) => el.child(extra))
      .child(div().child(String(count)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none());

    // The list's motion, as T3's (Sidebar.motion.ts): when the rows' order or sections change, a row that moved slides from
    // where it was, one that's new fades in from 40px above, one that left fades out where it was; 150ms ease-out. Not
    // while dragging (the lanes' gaps move then), and a change of more than 40 rows just shows. Herdr eases only later
    // changes to an element: a row that moves gets a new id, first drawn where it was, then let go to its place.
    const zoom = Number(settings()?.zoom) || 1;
    const TOP = 32; // The top row above the list.
    const ghostTop = () => Math.max(TOP + 8 + 24, Math.min(d.y - d.grab, (this.height ?? Infinity) - d.height - 8));
    const heightOf = (kind, key) => this.rowH[`${kind}:${key}`] ?? (kind === "slim" || kind === "marker" ? 30 : (this.cardH ?? 82) / zoom + 2);
    // Where each row sits in the list (logical px from its top, padding included): Pinned and Active from the top, the
    // shelves from the bottom once there's room, below the rest when there isn't. While dragging, with the labels,
    // the gap and the lifted row as the lanes draw them, so a drop goes on from there. The shelves' headers, Show more
    // and Active's empty line move with them (`m:` keys), as T3's list markers do, so nothing slides over them.
    const place = () => {
      const at = new Map(), gapH = plan?.section === "settled" ? 30 : cardH + 2;
      const put1 = (a, kind, y) => { const h = dragging && plan && a.address === d.from ? 0 : heightOf(kind, a.address); at.set(a.address, { y, h, kind, a }); return h; };
      const mark = (key, y, h = heightOf("marker", key)) => { at.set(key, { y, h, kind: "marker" }); return h; };
      let y = 8 + (dragging ? 24 : 0);
      for (const a of pinned) { if (dragging && plan?.gap === a.address) y += gapH; y += put1(a, "card", y); }
      if (dragging) y += (plan?.gap === "end-pinned" || plan?.gap === "head-pinned" ? gapH : 0) + 24;
      for (const a of out) { if (dragging && plan?.gap === a.address) y += gapH; y += put1(a, "card", y); }
      if (!out.length && dragging) y += 38;
      if (!list.length) y += mark("m:empty", y);
      const shelf = [];
      let b = 12;
      if (work.length) { shelf.push(["m:working", "marker", b]); b += 30; for (const a of busyRows) { shelf.push([a, "work", b]); b += heightOf("work", a.address); } }
      if (nap.length) { shelf.push(["m:snoozed", "marker", b]); b += 30; for (const a of napRows) { shelf.push([a, "slim", b]); b += a.address === d?.from && dragging && plan ? 0 : 30; } }
      if (put.length || dragging) {
        shelf.push(["m:settled", "marker", b]); b += 30;
        for (const a of rows) { if (dragging && plan?.gap === a.address) b += gapH; shelf.push([a, "slim", b]); b += a.address === d?.from && dragging && plan ? 0 : 30; }
        if (this.open && put.length > this.limit) { shelf.push(["m:more", "marker", b]); b += 30; }
      }
      const base = Math.max(y, (this.listH ?? 0) - 8 - b);
      for (const [a, kind, off] of shelf) kind === "marker" ? mark(a, base + off) : put1(a, kind, base + off);
      return at;
    };
    {
      const at = place(), sig = [...at].map(([k, v]) => `${k}:${v.kind}`).join("\n"), m = this.motion;
      if (!m || dragging || this.sweep?.moved || sig === m.sig) this.motion = { exits: [], fly: {}, gen: {}, ...m, sig, at };
      else {
        const fly = {}, gen = m.gen, exits = [...m.at].filter(([k]) => !at.has(k)).map(([key, v]) => ({ key, ...v }));
        const fresh = [...at.keys()].filter((k) => !m.at.has(k));
        if (fresh.length + exits.length <= 40) {
          // A row that comes or goes rides with the nearest kept row above it (still, it just fades); with none, 40px.
          let riding;
          for (const [k, v] of at) {
            const was = m.at.get(k), from = this.landed?.key === k ? this.landed.y : was?.y;
            if (from === undefined) {
              gen[k] = (gen[k] ?? 0) + 1;
              fly[k] = { top: riding ?? -Math.min(v.h, 40), fade: true };
              continue;
            }
            riding = from - v.y;
            if (riding === 0) continue;
            gen[k] = (gen[k] ?? 0) + 1;
            fly[k] = { top: riding };
          }
          const old = [...m.at.keys()];
          for (const x of exits) {
            const above = old.slice(0, old.indexOf(x.key)).reverse().find((k) => at.has(k));
            x.travel = above === undefined ? Math.min(x.h, 40) : -(fly[above]?.top ?? 0);
          }
        }
        const step = (m.step ?? 0) + 1;
        this.motion = { sig, at, gen, fly, exits: fresh.length + exits.length <= 40 ? exits : [], step, leaving: false };
        // A frame drawn where they were, then let go.
        cx.timer.after(16, (cx) => { if (this.motion.step !== step) return; this.motion.fly = {}; this.motion.leaving = true; cx.notify(); });
        cx.timer.after(MOTION.duration + 50, (cx) => { if (this.motion.step !== step) return; this.motion.exits = []; cx.notify(); });
      }
      this.landed = null;
    }
    // A row in its wrapper, which flies: drawn first where it was (or 40px up and clear, coming in), then let go.
    const fly = (key, kind, child) => {
      const f = this.motion.fly[key];
      return div().id(`fly-${key}-${this.motion.gen[key] ?? 0}`).flex_none().relative()
        .top(f?.top ?? 0).opacity(f?.fade ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION)
        .on_size_change((size) => { this.rowH[`${kind}:${key}`] = size.height / zoom + (kind === "card" || kind === "work" ? 2 : 0); })
        .child(child);
    };
    // A row that left, drawn inert where it was and fading out, riding as T3's clones do.
    const leaving = (x) => {
      if (x.kind === "marker") return null;
      let drawn;
      if (!kids.has(x.key)) kids.set(x.key, []); // Gone: drawn as it was, with no sub-agents.
      try { drawn = x.kind === "slim" ? slim(x.a, true) : card(x.a, true); } catch { return null; } // Gone with too much of its state.
      const away = this.motion.leaving;
      return div().id(`leaving-${x.key}-${this.motion.step}`).absolute().left(8).right(8).top(x.y + (away ? x.travel ?? 0 : 0))
        .opacity(away ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION).child(drawn);
    };
    this.ticking = busyRows.length > 0 || pinned.some(working);
    // The first shelf takes the free space above it, so both sit at the bottom.
    const n = this.notice;
    const notice = n && h_flex().id(`undo-notice-${n.gen}`).absolute().left(0).right(0).top(-12).h(24).px(10).gap(4).items_center()
      .bg(t.chrome).text_size(11).text_color(t.dim).opacity(n.shown ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
      .child(div().min_w(0).truncate().child(`${n.action} ${n.count} agent${n.count === 1 ? "" : "s"},`))
      // As T3's InlineButton: medium, foreground, underlined on hover.
      .when(n.live, (el) => el.child(div().id("undo-notice-undo").flex_none().font_medium().text_color(t.foreground).hover((s) => s.underline())
        .role("button").accessibility_label("Undo")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          // Latest first: each puts back what it found, as the runs happened.
          for (const undo of [...n.undos].reverse()) undo(cx);
          this.forget(cx);
        })
        .child("Undo")));
    const shelves = v_flex().id("shelves").relative().pt(12).flex_none()
      .when(Boolean(notice), (el) => el.child(notice))
      .when(work.length > 0, (el) => el
        .child(fly("m:working", "marker", shelf("working-header", "Working", work.length, this.workOpen, () => {
          this.workOpen = !this.workOpen;
          localStorage.setItem("working-open", String(this.workOpen));
        }).on_mouse_move((_e, cx) => aim(null, cx))))
        .child(v_flex().gap(2).children(busyRows.map((a) => fly(a.address, "work", card(a))))));
    // T3's Snoozed shelf, between Working and Settled. Nothing lands on it, so its header takes no drop.
    const napShelf = v_flex().id("snoozed").flex_none()
      .child(fly("m:snoozed", "marker", shelf("snoozed-header", "Snoozed", nap.length, this.napOpen, () => {
        this.napOpen = !this.napOpen;
        localStorage.setItem("snoozed-open", String(this.napOpen));
      }).on_mouse_move((_e, cx) => aim(null, cx))))
      .children(lane("snoozed", napRows, (a) => slim(a), 0));
    // Clear closes settled agents' panes; Herdr then closes emptied tabs. The one in view stays.
    const spaceNow = sp.find((s) => s.active), tabNow = spaceNow?.tabs.find((c) => c.active)?.id;
    const doomed = put.filter((a) => a.pane && !viewing(a) && a.tab !== tabNow);
    // With nothing to clear the button goes, and a gone element hears no pointer-leave: drop its hover.
    if (doomed.length === 0 && this.hot === "settled-clear") this.hot = null;
    this.clearSettled = () => {
      const gone = new Set(doomed.map((a) => a.pane));
      for (const id of new Set(doomed.map((a) => a.space))) {
        const s = sp.find((s) => s.id === id), tabs = s?.tabs.map((c) => c.id) ?? [];
        const mine = ps.filter((p) => tabs.includes(p.tab));
        // The space stays: pane.close refuses its last pane, so a space left empty gets a fresh shell tab first,
        // where its terminals are now: an unnamed space is named after that, and s.folder is only where it began.
        if (mine.every((p) => gone.has(p.pane))) run("tab.new", { space: id, folder: mine.find((p) => p.cwd)?.cwd || s.folder });
        for (const a of doomed.filter((a) => a.space === id)) run("pane.close", { pane: a.pane });
      }
      // tab.new shows the new tab; go back to where the person was.
      if (tabNow) { run("space.select", { id: spaceNow.id }); run("tab.select", { id: tabNow }); }
    };
    const clearButton = doomed.length > 0 && tip(this.hot, t, "settled-clear", "Clear settled agents", h_flex().id("settled-clear").h(20).px(6).flex_none().items_center().rounded(4)
      .text_color(lit("settled-clear", t.dim)).on_hover(glow("settled-clear"))
      .role("button").accessibility_label("Clear settled agents")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.hot = null; // The dialog covers it, before the pointer can report leaving it.
        openOverlay({ mod: "confirm", kind: "dialog", width: 400, height: 170, props: {
          title: `Close ${doomed.length} pane${doomed.length === 1 ? "" : "s"}?`,
          detail: "This ends the terminals of your settled agents. The tab you're on stays.",
          command: { name: "t3-inbox.clear" },
        } });
        cx.notify();
      })
      .child("Clear"));
    const tail = v_flex().id("settled").flex_none()
      .child(fly("m:settled", "marker", shelf("settled-header", "Settled", put.length, this.open, () => {
        this.open = !this.open;
        this.limit = FIRST;
        localStorage.setItem("open", String(this.open));
      }, clearButton).on_mouse_move((_e, cx) => aim({ section: "settled" }, cx))
        // As T3's shelf header: brighter while anything is lifted, accent as the target.
        .when(dragging, (el) => el.text_color(hot("settled") ? t.accent : t.foreground))))
      .when(dragging && others(rows).length === 0 && !(rows.length > 0 && !plan), (el) => el
        .child(plan?.gap === "head-settled" ? gap("head-settled") : placeholder("settled", "Settled")))
      .children(lane("settled", rows, (a) => slim(a), 0))
      .when(this.open && put.length > this.limit, (el) => el.child(fly("m:more", "marker", h_flex().id("settled-more").h(30).px(10).gap(8).flex_none().items_center().rounded(8)
        .text_color(lit("settled-more", t.dim)).hover((s) => s.bg(t.hover)).on_hover(glow("settled-more"))
        .role("button").accessibility_label("Show more settled agents")
        .on_click((_e, cx) => {
          this.hot = null; // It may go, before the pointer can report leaving it.
          this.limit += MORE;
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none())
        .child(`Show ${Math.min(MORE, put.length - this.limit)} more`))));

    // T3's top row: search on the left, then the space filter, new space and new tab.
    const tool = (id, label, icon, fn, more) => tip(this.hot, t, id, label, div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover)).on_hover(glow(id))
      .role("button").accessibility_label(label).on_click(fn)
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).text_color(lit(id, t.dim))), more);
    // The filter shows what it filters to: one avatar, two overlapping, or the plain filter icon.
    const scoped = sp.filter((s) => scope.includes(s.id));
    const choice = (s, i) => {
      const on = s.id ? scope.includes(s.id) : scope.length === 0;
      // Selection is a check badge on the icon, as in T3.
      return h_flex().id(`scope-${s.id ?? "all"}`).h(32).px(8).gap(8).flex_none().items_center().rounded(6)
        .when(i === this.scopeAt, (el) => el.bg(t.selected))
        .on_hover((over, cx) => { if (over && this.scopeAt !== i) { this.scopeAt = i; cx.notify(); } })
        .role("button").accessibility_label(s.name)
        .on_click((e, cx) => this.pick(s, e.modifiers.shift, cx))
        .child(div().relative().flex_none()
          .child(s.id ? avatar(s.id, s.name, 16) : svg("mods/workspace-chrome/folder.svg").size(16).text_color(t.muted))
          .when(on, (el) => el.child(h_flex().absolute().right(-4).bottom(-4).size(12).rounded_full().bg(t.accent)
            .border(2).border_color(t.popover).items_center().justify_center()
            .child(svg("mods/workspace-chrome/check.svg").size(7).text_color("#ffffff")))))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name));
    };
    const filter = Popover.new("inbox-scope-menu").anchor("top_right").open(this.scopeOpen)
      .on_open_change((open, cx) => {
        this.scopeOpen = open;
        if (open) {
          this.scopeAt = 0;
          this.search.set_value("");
          this.search.focus();
        }
        cx.notify();
      })
      .trigger(h_flex().id("inbox-scope").size(26).flex_none().items_center().justify_center().rounded(6)
        .hover((s) => s.bg(t.hover)).on_hover(glow("inbox-scope"))
        .role("button").accessibility_label(scoped.length ? `Filter by space: ${scoped.map((s) => s.name).join(", ")}` : "Filter by space")
        .child(scoped.length > 1
          ? h_flex().children(scoped.slice(0, 2).map((s, i) => avatar(s.id, s.name, 14).when(i > 0, (el) => el.ml(-6))))
          : scoped.length
            ? avatar(scoped[0].id, scoped[0].name, 16)
            : svg("mods/t3-inbox/list-filter.svg").size(14).text_color(lit("inbox-scope", t.dim))))
      .content(v_flex().id("inbox-scope-panel").w(260).max_h(360).mt(4).p(6).gap(2).rounded(10)
        .bg(t.popover).border_1().border_color(t.border).text_size(13)
        .on_key_down((e, cx) => {
          const n = this.matches().length;
          if (n === 0 || (e.key !== "down" && e.key !== "up")) return;
          this.scopeAt = (this.scopeAt + (e.key === "down" ? 1 : n - 1)) % n;
          cx.stop_propagation();
          cx.notify();
        })
        .child(h_flex().h(32).px(8).gap(8).flex_none().items_center().border_b_1().border_color(t.border)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(v_flex().id("inbox-scope-list").min_h(0).pt(4).gap(2).overflow_y_scroll()
          .children(this.matches().map(choice))
          .when(this.matches().length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No matching spaces.")))));
    // Right edge as the brand bar's above (pr 10), so the two rows of icons line up.
    const top = h_flex().id("inbox-top").h(32).pl(8).pr(10).gap(2).flex_none().items_center()
      .child(h_flex().id("inbox-search").flex_1().h(26).px(10).gap(8).items_center().rounded(6)
        .text_color(lit("inbox-search", t.dim)).hover((s) => s.bg(t.hover)).on_hover(glow("inbox-search"))
        // Each opens over its button, before the pointer can report leaving it.
        .role("button").accessibility_label("Search").on_click((_e, cx) => { this.hot = null; run("mod.open", { name: "picker" }); cx.notify(); })
        .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(lit("inbox-search", t.dim)))
        .child(div().child("Search")))
      .child(tip(this.scopeOpen ? null : this.hot, t, "inbox-scope", "Filter by space", filter, { hint: "Shift+click to pick several", below: true }))
      .child(tool("inbox-new-space", "New space", "folder-plus", () => newSpace(), { action: "space.new" }))
      // The layout passes its own menu; docked alone, the shipped one.
      .child(tool("inbox-new-tab", "New tab", "square-pen", (_e, cx) => { this.hot = null; run("mod.open", { name: props()?.newMenu ?? "new-menu" }); cx.notify(); }));

    const tree = v_flex().id("t3-inbox-root").relative().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((size) => { this.height = size.height; this.width = size.width; })
      // Esc puts a lifted row back (the sidebar holds the keyboard only while something is lifted).
      .track_focus(this.keys).on_key_down((e, cx) => {
        if (e.keystroke !== "escape" || !(this.drag || this.sweep || this.back)) return;
        this.endDrag();
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        const g = this.drag ?? this.sweep;
        if (!g || (!g.moved && Math.hypot(e.position.x - g.at.x, e.position.y - g.at.y) <= 6)) return;
        if (!g.moved) { this.back = focused(); this.keys.focus(); }
        g.moved = true;
        g.last = e.local_position ?? g.last;
        if (this.drag) this.drag.y = e.local_position?.y ?? this.drag.y;
        cx.notify();
      })
      // Released anywhere in the sidebar, it lands where the gap shows.
      .on_mouse_up("left", (_e, cx) => { finish(cx); cx.notify(); })
      // Herdr reports no release outside the sidebar, so leaving decides. Off the top or bottom edge (the Pinned
      // label or the Settled shelf sit there) it lands where the badge says, as T3 keeps the last target past the
      // list's ends; off a side it goes back.
      .on_hover((on, cx) => {
        if (!on) this.quiet = null;
        if (on || !(this.drag || this.sweep || this.back)) return;
        const p = (this.drag ?? this.sweep)?.last, w = this.width ?? Infinity, h = this.height ?? Infinity;
        const side = !p || Math.min(p.x, w - p.x) < Math.min(p.y, h - p.y);
        if (side) this.endDrag(); else finish(cx);
        cx.notify();
      })
      .child(top)
      .child(v_flex().id("inbox-list").relative().flex_1().min_h(0).px(8).py(8).overflow_y_scroll()
        .on_size_change((size) => { this.listH = size.height / zoom; })
        // Rows leaving fade out where they were, as T3's clones.
        .children(this.motion?.exits.map(leaving).filter(Boolean) ?? [])
        .child(boundary("pinned", "Pinned", "pinned", pinTo(others(pinned)[0]?.address)))
        .child(gap("head-pinned"))
        .children(lane("pinned", pinned, (a) => card(a), 2))
        .child(boundary("active", "Active", "active", { section: "active" }))
        .when(dragging && others(out).length === 0 && !(out.length > 0 && !plan), (el) => el
          .child(plan?.gap === "head-active" ? gap("head-active") : placeholder("active", "Active")))
        .children(lane("active", out, (a) => card(a), 2))
        // As T3's: only a list with nothing in it says so; Active alone being empty stays blank.
        .when(list.length === 0, (el) => el.child(fly("m:empty", "marker", div().px(8).py(24).text_center().text_size(12).text_color(t.dim)
          .child(!every.length ? "Nothing here yet. Agents and panes that report a status show up here."
            : scoped.length > 1 ? "Nothing in these spaces yet" : `Nothing in ${scoped[0].name} yet`))))
        // While dragging, Settled shows even empty: it's where a drop settles.
        // The free space above the shelves pushes them to the bottom; a drag over it lands in Active, as T3's
        // nearest-row drop does.
        .child(div().id("active-rest").flex_1().min_h(0).on_mouse_move((_e, cx) => aim({ section: "active" }, cx)))
        .child(shelves.when(nap.length > 0, (el) => el.child(napShelf)).when(put.length > 0 || (dragging && !busy(lifted)), (el) => el.child(tail))))
      // The lifted row moves only up and down, inside the list and below the Pinned label (T3's clamps).
      .when(Boolean(lifted) && d.y != null, (el) => el.child(div().id("drag-ghost").absolute().left(8).right(8)
        .top(ghostTop())
        .rounded(10).bg(t.selected).border(1).border_color(t.accent).shadow_lg()
        .child(fromShelf ? slim(lifted, true) : card(lifted, true))));
    // A row that left the list under the pointer (to the folded Working shelf, or filtered out) never reports the pointer
    // leaving it: forget it, or its card and Settle come back with it.
    const gone = this.hovered;
    if (gone && !drawn.order.includes(gone)) {
      this.hovered = null;
      this.detailsWait?.cancel();
      if (this.details === gone) this.details = null;
      if (this.detailsOut === gone) this.detailsOut = null;
    }
    return tree;
  }
}
