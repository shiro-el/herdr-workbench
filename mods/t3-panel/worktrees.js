// Worktrees: every checkout of the focused terminal's repo, what each holds (branch, ↑↓, uncommitted files,
// its pull request) and which agents work in it; open one as a space, or clean up one whose work has landed.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, agents, terminals, theme, home, run as runCommand, openOverlay } from "herdr";
import { terminalsOn, follow, location, shownView, sh, run, lines, card, empty, button, pill, glyph, spinner, within, baseName, copyText, openUrl, MONO } from "./common.js";

const SYNC = 15000, PRS = 60000;

// One script, one round trip (another machine's repo answers as fast as this one's).
const SCRIPT = `cd "$1" || exit 1
git worktree list --porcelain; echo @@
git for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)' refs/heads; echo @@
d=$(git symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null)
[ -z "$d" ] && for b in main master; do git rev-parse -q --verify "$b" >/dev/null && d=$b && break; done
echo "$d"; echo @@
[ -n "$d" ] && git branch --merged "$d" --format='%(refname:short)'; echo @@
git remote get-url origin 2>/dev/null; echo @@
git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r w; do
  [ -d "$w" ] || continue
  printf '%s\\t%s\\n' "$w" "$(git -C "$w" --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
done`;

function parse(out) {
  const [wt, refs, def, merged, origin, dirty] = out.replace(/\r/g, "").split("@@\n");
  const list = [];
  for (const block of (wt ?? "").split("\n\n")) {
    const w = {};
    for (const l of block.split("\n")) {
      const [k, ...v] = l.split(" ");
      if (k === "worktree") w.path = v.join(" ");
      else if (k === "HEAD") w.head = v[0];
      else if (k === "branch") w.branch = v.join(" ").replace(/^refs\/heads\//, "");
      else if (k === "detached") w.detached = true;
      else if (k === "bare") w.bare = true;
      else if (k === "locked") w.locked = true;
      else if (k === "prunable") w.prunable = true;
    }
    if (w.path && !w.bare) list.push(w);
  }
  const track = {};
  for (const l of lines(refs)) {
    const [name, up, tr] = l.split("\t");
    const ahead = Number(/ahead (\d+)/.exec(tr ?? "")?.[1] ?? 0), behind = Number(/behind (\d+)/.exec(tr ?? "")?.[1] ?? 0);
    track[name] = { up: up || null, ahead, behind, gone: (tr ?? "").includes("gone") };
  }
  const changed = Object.fromEntries(lines(dirty).map((l) => { const [p, n] = l.split("\t"); return [p, Number(n) || 0]; }));
  const base = lines(def)[0] ?? null;
  const mergedSet = new Set(lines(merged).map((b) => b.trim()));
  const slug = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(lines(origin)[0] ?? "")?.[1] ?? null;
  return { list: list.map((w, i) => ({ ...w, main: i === 0, ...(track[w.branch] ?? {}), changed: changed[w.path] ?? null })), base, merged: mergedSet, slug };
}

export class Worktrees {
  constructor(view, cx) {
    this.view = view;
    this.loc = null; this.data = null; this.root = null; this.error = null; this.loading = false;
    this.prs = {}; // slug -> { at, byBranch }
    this.ask = null; this.busy = null; this.note = null;
    cx.timer.every(SYNC, (cx) => { if (shownView() === "worktrees") this.refresh(cx, true); });
    follow(cx, "worktrees", () => JSON.stringify(location(this.loc)), (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx, quiet = false) {
    if (this.loading) return;
    const loc = location(this.loc);
    this.loc = loc;
    if (!loc.cwd) { this.data = null; this.root = null; return cx.notify(); }
    this.loading = !quiet; cx.notify();
    cx.spawn(async (cx) => {
      const top = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: loc.cwd, on: loc.on });
      const common = top.code === 0 ? lines(top.stdout)[0] : null;
      const root = common ? common.replace(/[\\/]\.git[\\/]?$/, "") : null;
      if (!root) { this.root = null; this.data = null; this.error = null; this.loading = false; return cx.notify(); }
      const r = await sh(SCRIPT, [root], { on: loc.on });
      this.loading = false;
      if (r.code !== 0 && !r.stdout) { this.error = (r.stderr || "git failed").trim().split("\n").pop(); return cx.notify(); }
      this.error = null; this.root = root; this.data = parse(r.stdout);
      cx.notify();
      this.loadPrs(this.data.slug, cx);
    });
  }

  // Pull requests by head branch, through gh here (it reaches GitHub whatever machine the repo is on).
  loadPrs(slug, cx) {
    if (!slug) return;
    const got = this.prs[slug];
    if (got && Date.now() - got.at < PRS) return;
    this.prs[slug] = { at: Date.now(), byBranch: got?.byBranch ?? {} };
    cx.spawn(async (cx) => {
      const r = await run("gh", ["pr", "list", "-R", slug, "--state", "all", "--limit", "200", "--json", "number,state,headRefName,isDraft,url"]);
      if (r.code !== 0) return;
      try {
        const byBranch = {};
        // gh lists newest first: the first pull request of a branch is its latest.
        for (const p of JSON.parse(r.stdout)) byBranch[p.headRefName] ??= p;
        this.prs[slug] = { at: Date.now(), byBranch };
        cx.notify();
      } catch { /* not JSON: keep the old */ }
    });
  }

  // Remove a checkout (git refuses one with changes), and its branch when asked.
  remove(w, branch, cx) {
    const { on } = this.loc, root = this.root;
    this.busy = w.path; this.ask = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await run("git", ["worktree", "remove", w.path], { cwd: root, on });
      let msg = r.code === 0 ? `Removed ${baseName(w.path)}` : (r.stderr || "git worktree remove failed").trim().split("\n").pop();
      if (r.code === 0 && branch && w.branch) {
        const b = await run("git", ["branch", branch, w.branch], { cwd: root, on });
        msg += b.code === 0 ? ` and branch ${w.branch}` : ` (branch kept: ${(b.stderr || "").trim().split("\n").pop()})`;
      }
      this.busy = null; this.note = { text: msg, error: r.code !== 0, at: Date.now() };
      this.refresh(cx, true);
    });
  }

  prune(cx) {
    const { on } = this.loc;
    cx.spawn(async (cx) => {
      const r = await run("git", ["worktree", "prune"], { cwd: this.root, on });
      this.note = { text: r.code === 0 ? "Pruned missing worktrees" : (r.stderr || "").trim(), error: r.code !== 0, at: Date.now() };
      this.refresh(cx, true);
    });
  }

  render(cx) {
    const t = theme(), view = this.view;
    const tools = [
      this.loading ? h_flex().px(5).child(spinner(13, t.muted)) : button("wt-refresh", "", t, (_e, cx) => this.refresh(cx), { icon: "refresh", invisible: true, tooltip: "Refresh" }),
      button("wt-new", "", t, () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: this.loc?.space, folder: this.loc?.cwd, action: "new" } }), { icon: "plus", invisible: true, tooltip: "New worktree…", enabled: Boolean(this.root) }),
    ];
    const d = this.data;
    if (!this.loc?.cwd) return card(t, "wt", "Worktrees", null, tools, empty(t, "No folder", "Focus a terminal in a repository."));
    if (this.error) return card(t, "wt", "Worktrees", null, tools, empty(t, "Couldn't read the worktrees", this.error, [button("wt-retry", "Retry", t, (_e, cx) => this.refresh(cx), { icon: "refresh" })]));
    if (!d) return card(t, "wt", "Worktrees", null, tools, this.loading ? empty(t, "Reading…", null) : empty(t, "Not a repository", "The focused terminal's folder isn't in a git repository."));

    const ps = panes(), ag = agents(), sp = spaces();
    const on = this.loc.on ?? null;
    // Each terminal is in the deepest worktree holding its folder.
    const owner = (cwd) => d.list.filter((w) => within(cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path;
    const sameMachine = (spaceId) => (sp.find((s) => s.id === spaceId)?.machine ?? null) === on;
    const prs = this.prs[d.slug]?.byBranch ?? {};
    // Every agent terminal on this machine, sub-agents too (they have no pane): by its own folder.
    const named = new Map(ag.map((a) => [a.address, a]));
    const agentsHere = terminalsOn(on, terminals()).filter((k) => k.agent && k.cwd)
      .map((k) => ({ ...k, status: named.get(k.address)?.status ?? k.status }));
    const tilde = (p) => { const h = on ? null : home(); return h && within(p, h) ? "~" + p.replace(/\\/g, "/").slice(h.replace(/\\/g, "/").length) : p; };
    if (d.list.some((w) => w.prunable)) tools.unshift(button("wt-prune", "Prune", t, (_e, cx) => this.prune(cx), { tooltip: "Forget worktrees whose folder is gone" }));

    const row = (w) => {
      const working = agentsHere.filter((a) => owner(a.cwd) === w.path);
      const space = sp.find((s) => (s.machine ?? null) === on && s.folder && within(s.folder, w.path) && owner(s.folder) === w.path);
      const pr = w.branch && !w.main ? prs[w.branch] : null;
      const landed = !w.main && w.branch && w.branch !== d.base && (d.merged.has(w.branch) || pr?.state === "MERGED");
      const hot = view.hot === `wt:${w.path}`, asking = this.ask === w.path, busy = this.busy === w.path;
      const prColor = pr && (pr.state === "MERGED" ? "#a371f7" : pr.state === "CLOSED" ? t.ansi1 : pr.isDraft ? t.dim : t.ansi2);
      const name = w.branch ?? (w.detached ? `detached ${String(w.head ?? "").slice(0, 7)}` : baseName(w.path));
      const go = () => space ? runCommand("space.select", { id: space.id }) : runCommand("space.new", { folder: w.path, ...(on ? { machine: on } : {}) });
      const canRemove = !w.main && !w.locked && working.length === 0 && w.changed === 0;
      const why = w.main ? "The main checkout stays" : w.locked ? "Locked" : working.length ? "Agents work in it" : w.changed ? "It has uncommitted changes" : null;
      return v_flex().id(`wt-${w.path}`).px(12).py(8).gap(3).border_b(1).border_color(t.border)
        .bg(within(this.loc.cwd, w.path) && owner(this.loc.cwd) === w.path ? t.selected : hot ? t.hover : t.background)
        .on_hover((h, cx) => { view.hot = h ? `wt:${w.path}` : view.hot === `wt:${w.path}` ? null : view.hot; cx.notify(); })
        .cursor_pointer().on_click(go)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(glyph(w.main ? "git" : "worktree", 13, w.main ? t.muted : t.ansi4 ?? t.muted))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).child(name))
          .when(w.main, (e) => e.child(pill("main", t.muted, t)))
          .when(Boolean(pr), (e) => e.child(h_flex().id(`wt-pr-${w.path}`).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); openUrl(pr.url); })
            .child(pill(`#${pr.number} ${pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open"}`, prColor, t))))
          .when(Boolean(landed) && pr?.state !== "MERGED", (e) => e.child(pill("merged", "#a371f7", t)))
          .when(Boolean(w.gone), (e) => e.child(pill("upstream gone", t.blocked, t)))
          .when(Boolean(w.prunable), (e) => e.child(pill("missing", t.ansi1, t))))
        .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim).min_w(0)
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).child(!w.main && within(w.path, this.root) ? w.path.replace(/\\/g, "/").slice(this.root.replace(/\\/g, "/").length + 1) : tilde(w.path)))
          .when(w.ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${w.ahead}`)))
          .when(w.behind > 0, (e) => e.child(div().text_color(t.ansi1).child(`↓${w.behind}`)))
          .child(div().flex_none().text_color(w.changed ? t.blocked : t.dim).child(w.changed == null ? "" : w.changed ? `${w.changed} changed` : "clean")))
        .when(working.length > 0 || Boolean(space), (e) => e.child(h_flex().gap(6).items_center().flex_wrap().pt(1)
          .when(Boolean(space), (x) => x.child(pill(space.name || baseName(space.folder), t.muted, t)))
          .children(working.map((a) => h_flex().id(`wt-agent-${a.address}`).gap(4).items_center().px(5).h(18).rounded(5).bg(t.raised).text_size(11)
            .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); runCommand("agent.focus", { terminal: a.address }); })
            .child(a.status === "working" ? spinner(10, t.working) : div().size(6).rounded_full().bg(t[a.status] ?? t.idle))
            .child(div().max_w(140).truncate().child(a.name))))))
        .when(asking, (e) => e.child(h_flex().gap(6).pt(4).items_center()
          .child(div().flex_1().text_size(12).text_color(t.muted).child("Remove this worktree?"))
          .child(button(`wt-rm-${w.path}`, "Remove", t, (_e, cx) => this.remove(w, null, cx), { danger: true }))
          .when(Boolean(landed), (x) => x.child(button(`wt-rmb-${w.path}`, "+ branch", t, (_e, cx) => this.remove(w, pr?.state === "MERGED" && !d.merged.has(w.branch) ? "-D" : "-d", cx), { danger: true, tooltip: `Also delete branch ${w.branch}` })))
          .child(button(`wt-no-${w.path}`, "Cancel", t, (_e, cx) => { this.ask = null; cx.notify(); }))))
        .when((hot || busy) && !asking, (e) => e.child(h_flex().gap(4).pt(3)
          .child(button(`wt-go-${w.path}`, space ? "Go to space" : "Open as space", t, go, { icon: "arrow-right" }))
          .child(button(`wt-copy-${w.path}`, "", t, () => copyText(w.path), { icon: "copy", tooltip: "Copy path" }))
          .child(div().flex_1())
          .child(busy ? h_flex().px(6).child(spinner(12, t.muted))
            : button(`wt-ask-${w.path}`, "", t, (_e, cx) => { this.ask = w.path; cx.notify(); }, { icon: "trash", danger: canRemove, enabled: canRemove, tooltip: why ?? (landed ? "Remove (its work has landed)" : "Remove") }))));
    };

    const note = this.note && Date.now() - this.note.at < 8000 ? this.note : null;
    const repo = d.slug ?? baseName(this.root);
    const landedCount = d.list.filter((w) => !w.main && w.branch && (d.merged.has(w.branch) || prs[w.branch]?.state === "MERGED")).length;
    return card(t, "wt", repo, `${d.list.length} worktree${d.list.length === 1 ? "" : "s"}${landedCount ? ` · ${landedCount} landed` : ""}${on ? ` · ${on}` : ""}`, tools,
      v_flex().flex_1().min_h(0)
        .when(Boolean(note), (e) => e.child(div().px(12).py(6).text_size(12).text_color(note.error ? t.ansi1 : t.muted).bg(t.raised).child(note.text)))
        .child(v_flex().id("wt-list").flex_1().min_h(0).overflow_y_scroll().children(d.list.map(row))));
  }
}
