// Search: text in every file of the focused terminal's repository (or its folder), on its machine. rg there, else
// git grep, else grep; plain text, smart case (lowercase matches either case), what .gitignore ignores left out.
// A match opens its file in t3-files' floating viewer.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, shared, openOverlay } from "herdr";
import { follow, location, sh, card, empty, button, spinner, glyph, MONO } from "./common.js";

const ROW = 22, LIMIT = 2000;

// $1 the folder, $2 the text, $3 "-i" or "". Prints the repository's top (or the folder), then one match a line:
// path NUL line (":" or NUL) text.
const SEARCH = `top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || top=$1
cd "$top" || exit 2
printf '%s\\n' "$top"
if command -v rg >/dev/null 2>&1; then
  rg --null --line-number --no-heading --color never --fixed-strings --smart-case --max-columns 400 --max-columns-preview -e "$2" . 2>/dev/null
elif git rev-parse --git-dir >/dev/null 2>&1; then
  git grep --null -n -I --fixed-strings $3 -e "$2" 2>/dev/null
else
  grep -rnIZ --fixed-strings --exclude-dir=.git $3 -e "$2" . 2>/dev/null
fi | head -n ${LIMIT}`;

const slashes = (s) => String(s).replace(/\\/g, "/");

// t3-files' viewer, as its tree opens one: the shared window, or one of the file's own while that holds unsaved changes.
function openFile(root, path, on) {
  const own = Boolean(shared("t3-files.view-dirty"));
  openOverlay({ mod: "t3-files", kind: "window", key: own ? `t3-files:${on ?? ""}:${root}/${path}` : "t3-files:view",
    width: 780, height: 580, props: { viewer: { root, path, on, slot: !own } } });
}

function parse(out) {
  const lines = out.split("\n"), root = (lines.shift() ?? "").replace(/\r$/, "").replace(/\/+$/, "");
  const files = new Map();
  let count = 0;
  for (const l of lines) {
    const z = l.indexOf("\0");
    if (z < 0) continue;
    const path = slashes(l.slice(0, z)).replace(/^\.\//, ""), rest = l.slice(z + 1);
    const cut = rest.search(/[\0:]/);
    if (cut < 0) continue;
    const line = Number(rest.slice(0, cut));
    if (!line) continue;
    const text = rest.slice(cut + 1).replace(/\r$/, "");
    if (!files.has(path)) files.set(path, []);
    files.get(path).push({ line, text });
    count++;
  }
  return { root, files, count };
}

export class Search {
  constructor(view, cx) {
    this.view = view;
    this.loc = null; this.result = null; this.error = null; this.loading = false;
    this.seq = 0; this.folded = new Set();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search" });
    this.input.on("change", (_e, cx) => {
      const seq = ++this.seq;
      cx.timer.after(250, (cx) => { if (seq === this.seq) this.search(cx); });
    });
    this.input.on("submit", (_e, cx) => { this.seq++; this.search(cx, true); });
    // ctrl-shift-f (t3-tabs) shows this view and asks for the keyboard through a shared stamp.
    this.asked = shared("t3-panel.search-focus") ?? null;
    cx.timer.every(150, () => {
      const s = shared("t3-panel.search-focus") ?? null;
      if (s !== this.asked) { this.asked = s; this.input.focus(); }
    });
    follow(cx, "search", () => { const l = location(this.loc); return `${l.on}|${l.cwd}`; }, (cx) => { if (this.input.value().trim()) this.search(cx); });
  }

  // One or more characters on Enter, two while typing.
  search(cx, enter = false) {
    const q = this.input.value(), loc = location(this.loc);
    this.loc = loc;
    if (!q.trim() || (!enter && q.trim().length < 2) || !loc.cwd) { this.result = null; this.error = null; this.loading = false; return cx.notify(); }
    const seq = this.seq;
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      const r = await sh(SEARCH, [slashes(loc.cwd), q, /[A-Z]/.test(q) ? "" : "-i"], loc.on ? { on: loc.on } : {});
      if (seq !== this.seq) return;
      this.loading = false;
      if (!r.stdout.trim()) { this.result = null; this.error = (r.stderr || "Couldn't search here").trim().split("\n").pop(); return cx.notify(); }
      this.error = null;
      this.result = { ...parse(r.stdout), q, on: loc.on };
      this.folded = new Set();
      cx.notify();
    });
  }

  rows() {
    const out = [], res = this.result;
    if (!res) return out;
    for (const [path, hits] of res.files) {
      out.push({ key: `f:${path}`, path, hits: hits.length });
      if (!this.folded.has(path)) for (const h of hits) out.push({ key: `m:${path}:${h.line}`, path, ...h });
    }
    return out;
  }

  // The line with its first match in the accent: a lowercase query matches either case, as rg's smart case.
  line(t, text, q) {
    const hay = /[A-Z]/.test(q) ? text : text.toLowerCase(), needle = /[A-Z]/.test(q) ? q : q.toLowerCase();
    const lead = text.length - text.trimStart().length, at = hay.indexOf(needle);
    if (at < 0) return [div().child(text.trimStart())];
    // A long line starts near its match.
    const from = Math.max(lead, at - 40);
    return [div().flex_none().child((from > lead ? "…" : "") + text.slice(from, at)),
      div().flex_none().bg(t.accent + "33").text_color(t.foreground).rounded(2).child(text.slice(at, at + q.length)),
      div().child(text.slice(at + q.length))];
  }

  row(t, r, q) {
    const name = r.path.split("/").pop(), dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
    if (r.hits !== undefined) return h_flex().id(r.key).h(ROW).px(8).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .child(div().flex_none().w(10).text_size(10).text_color(t.dim).child(this.folded.has(r.path) ? "▸" : "▾"))
      .child(div().flex_none().max_w(200).truncate().font_medium().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir))
      .child(div().flex_none().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(r.hits)));
    return h_flex().id(r.key).h(ROW).pl(24).pr(8).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .child(div().flex_none().w(34).text_right().font_family(MONO).text_size(11).text_color(t.dim).child(String(r.line)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().font_family(MONO).text_size(11.5).text_color(t.muted)
        .children(this.line(t, r.text, q)));
  }

  click(id, cx) {
    const res = this.result, r = this.rows().find((x) => x.key === id);
    if (!res || !r) return;
    if (r.hits !== undefined) { if (this.folded.has(r.path)) this.folded.delete(r.path); else this.folded.add(r.path); return cx.notify(); }
    openFile(res.root, r.path, res.on);
  }

  render(_cx) {
    const t = theme(), res = this.result, rows = this.rows();
    const tools = [this.loading ? h_flex().px(5).child(spinner(13, t.muted))
      : button("search-again", "", t, (_e, cx) => { this.seq++; this.search(cx, true); }, { icon: "refresh", invisible: true, tooltip: "Search again" })];
    const sub = res ? `${res.count >= LIMIT ? `First ${LIMIT}` : res.count} ${res.count === 1 ? "match" : "matches"} in ${res.files.size} ${res.files.size === 1 ? "file" : "files"} · ${res.root}${res.on ? ` on ${res.on}` : ""}` : null;
    const field = h_flex().flex_none().m(8).h(30).px(8).gap(6).items_center().rounded(6).bg(t.input ?? t.raised).border_1().border_color(t.border)
      .child(glyph("search", 13, t.muted))
      .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground));
    const q = res?.q ?? "";
    const body = v_flex().flex_1().min_h(0).child(field)
      .child(!this.input.value().trim() ? empty(t, "Search files", "Text in every file of the focused terminal's repository. Enter searches one character too.")
        : this.error ? empty(t, "Nothing found", this.error)
        : !res ? empty(t, this.loading ? "Searching…" : "Type two characters or press Enter", null)
        : res.count === 0 ? empty(t, "No matches", `Nothing in ${res.root} has “${res.q}”.`)
        : div().flex_1().min_h(0).text_size(12.5).child(v_virtual_list("search-rows", rows.length, ROW, (i) => rows[i]?.key ?? String(i),
            (range) => rows.slice(range.start, range.end).map((r) => this.row(t, r, q)))
          .track_scroll(this.scroll).size_full()
          .on_item_click((id, cx) => this.click(id, cx))));
    return card(t, "search", "Search", sub, tools, body);
  }
}
