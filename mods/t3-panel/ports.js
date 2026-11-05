// Ports: what listens on the focused space's machine, which space each server belongs to (by its folder),
// and one click to open it here: another machine's port is forwarded over ssh first.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, terminals, theme, home, hc, shared, setShared, run as runCommand } from "herdr";
import * as fs from "fs/promises";
import { terminalsOn, spaceById, follow, location, shownView, sh, run, lines, card, empty, button, pill, glyph, spinner, within, baseName, openUrl, isWindows, MONO } from "./common.js";

const SYNC = 5000;

// port, address, pid, process, folder, command; one line per listening socket.
const LINUX = `LC_ALL=C ss -Hltnp 2>/dev/null | while read -r st q1 q2 local peer rest; do
  port=\${local##*:}; addr=\${local%:*}
  pid=$(printf %s "$rest" | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p')
  name=$(printf %s "$rest" | sed -n 's/.*(("\\([^"]*\\)".*/\\1/p')
  cwd=; cmd=
  if [ -n "$pid" ]; then cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null); cmd=$(tr '\\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-300); fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$port" "$addr" "$pid" "$name" "$cwd" "$cmd"
done`;
const WINDOWS = `$ps = @{}; Get-Process | ForEach-Object { $ps[$_.Id] = $_.ProcessName }
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "{0}\`t{1}\`t{2}\`t{3}\`t\`t" -f $_.LocalPort, $_.LocalAddress, $_.OwningProcess, $ps[[int]$_.OwningProcess] }`;

const listLocal = () => isWindows()
  ? run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS])
  : sh(LINUX);

function parse(out) {
  const byPort = new Map();
  for (const l of lines(out)) {
    const [port, addr, pid, name, cwd, cmd] = l.split("\t");
    const n = Number(port);
    if (!n) continue;
    const had = byPort.get(n);
    const a = (addr ?? "").replace(/^\[|\]$/g, "");
    const open = a === "*" || a === "0.0.0.0" || a === "::";
    if (had) { had.open ||= open; had.pid ||= pid; had.name ||= name; had.cwd ||= cwd; had.cmd ||= cmd; continue; }
    byPort.set(n, { port: n, addr: a, open, pid: pid || null, name: name || null, cwd: cwd || null, cmd: (cmd ?? "").trim() || null });
  }
  return [...byPort.values()].sort((x, y) => x.port - y.port);
}

export class Ports {
  constructor(view, cx) {
    this.view = view;
    this.loc = null; this.list = null; this.here = new Map(); this.error = null; this.loading = false;
    this.showAll = false; this.ask = null; this.note = null;
    this.targets = {}; // machine -> ssh target
    cx.timer.every(SYNC, (cx) => { if (shownView() === "ports") this.refresh(cx, true); });
    follow(cx, "ports", () => String(location(this.loc).on), (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx, quiet = false) {
    if (this.loading) return;
    const loc = location(this.loc);
    this.loc = loc;
    this.loading = !quiet; if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      const [there, here] = await Promise.all([loc.on ? sh(LINUX, [], { on: loc.on }) : listLocal(), loc.on ? listLocal() : null]);
      this.loading = false;
      if (there.code !== 0 && !there.stdout) { this.error = (there.stderr || "Couldn't list ports").trim().split("\n").pop(); return cx.notify(); }
      this.error = null;
      this.list = parse(there.stdout);
      this.here = new Map((here ? parse(here.stdout) : this.list).map((p) => [p.port, p]));
      cx.notify();
    });
  }

  async target(on) {
    if (this.targets[on]) return this.targets[on];
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try { for (const m of JSON.parse(r?.stdout ?? "{}").machines ?? []) this.targets[m.name] = m.target; } catch { /* none */ }
    return this.targets[on] ?? on;
  }

  // Forward a port of another machine to the same port here, then open it. With the tunnel key
  // (~/.ssh/herdr_tunnel, no passphrase, allowed only to forward there) ssh runs hidden; without it, or when
  // that fails, the tunnel is a terminal tab where ssh can ask for the password.
  forward(p, cx) {
    const on = this.loc.on;
    this.note = { text: `Forwarding :${p.port}…`, at: Date.now() }; cx.notify();
    cx.spawn(async (cx) => {
      const target = await this.target(on);
      const args = ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-L", `${p.port}:localhost:${p.port}`, target];
      const key = `${home()}/.ssh/herdr_tunnel`.replace(/\\/g, "/");
      let up = false;
      if (await fs.exists(key).catch(() => false)) {
        const quiet = ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...args];
        if (isWindows()) await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process ssh -WindowStyle Hidden -ArgumentList '${quiet.join("','")}'`]);
        else await sh('ssh -f "$@"', quiet);
        // Up once something here listens on the port.
        for (let i = 0; i < 8 && !up; i++) {
          await cx.sleep(500);
          up = parse((await listLocal()).stdout).some((x) => x.port === p.port);
        }
      }
      if (up) {
        this.note = { text: `localhost:${p.port} → ${on}:${p.port}`, at: Date.now() };
        openUrl(`http://localhost:${p.port}`);
      } else {
        runCommand("terminal.open", { argv: ["ssh", ...args], name: `:${p.port} ⇄ ${on}`, place: "tab" });
        this.note = { text: `ssh asks for the password in the new tab; then Open.`, at: Date.now() };
      }
      setShared("t3-panel.forwards", { ...(shared("t3-panel.forwards") ?? {}), [p.port]: on });
      this.refresh(cx, true);
    });
  }

  // Stop a tunnel: the ssh here that holds the port.
  unforward(p, cx) {
    const mine = this.here.get(p.port);
    if (!mine?.pid) return;
    cx.spawn(async (cx) => {
      if (isWindows()) await run("taskkill", ["/PID", String(mine.pid), "/F"]);
      else await run("kill", [String(mine.pid)]);
      const all = { ...(shared("t3-panel.forwards") ?? {}) }; delete all[p.port]; setShared("t3-panel.forwards", all);
      this.refresh(cx, true);
    });
  }

  kill(p, cx) {
    const on = this.loc.on;
    this.ask = null;
    cx.spawn(async (cx) => {
      const r = on || !isWindows() ? await run("kill", [String(p.pid)], { on }) : await run("taskkill", ["/PID", String(p.pid)]);
      this.note = { text: r.code === 0 ? `Stopped ${p.name ?? "process"} (${p.pid})` : (r.stderr || "kill failed").trim().split("\n").pop(), error: r.code !== 0, at: Date.now() };
      this.refresh(cx, true);
    });
  }

  render(cx) {
    const t = theme(), view = this.view;
    const on = this.loc?.on ?? null;
    const tools = [
      this.loading ? h_flex().px(5).child(spinner(13, t.muted)) : button("pt-refresh", "", t, (_e, cx) => this.refresh(cx), { icon: "refresh", invisible: true, tooltip: "Refresh" }),
    ];
    const title = on ?? "This computer";
    if (this.error) return card(t, "pt", "Ports", title, tools, empty(t, "Couldn't list ports", this.error, [button("pt-retry", "Retry", t, (_e, cx) => this.refresh(cx), { icon: "refresh" })]));
    if (!this.list) return card(t, "pt", "Ports", title, tools, empty(t, "Reading…", null));

    // A server is a space's when it runs in that space's folder, or in a folder one of its terminals is in.
    const sp = spaces().filter((s) => (s.machine ?? null) === on);
    const h0 = on ? null : home();
    // A home or the root holds everything: matching by it would put every server in one space.
    const norm = (f) => f.replace(/\\/g, "/").replace(/\/+$/, "");
    const broad = (f) => !f || /^(|\/home\/[^/]+|\/root|\/Users\/[^/]+|[A-Za-z]:\/Users\/[^/]+|[A-Za-z]:)$/.test(norm(f)) || (h0 && norm(f) === norm(h0));
    // Where each space's terminals are now (sub-agents too, by the label Herdr puts on them), not where it was made.
    const places = [];
    for (const k of terminalsOn(on, terminals())) {
      const s = spaceById(sp, k.space);
      if (s && !broad(k.cwd)) places.push([k.cwd, s]);
    }
    const spaceOf = (cwd) => cwd ? places.filter(([f]) => within(cwd, f)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? null : null;
    // Linux hands out 32768 and up to programs that ask for any port (agents' and editors' helpers): not servers you started.
    const rows = this.list.map((p) => ({ ...p, space: p.port < 32768 ? spaceOf(p.cwd) : null }));
    const mine = rows.filter((p) => p.space), rest = rows.filter((p) => !p.space);
    const h = on ? null : home();
    const tilde = (p) => h && within(p, h) ? "~" + p.replace(/\\/g, "/").slice(h.replace(/\\/g, "/").length) : p;

    const row = (p) => {
      const id = `pt:${p.port}`, hot = view.hot === id, asking = this.ask === p.port;
      const forwarded = on && this.here.has(p.port);
      const reach = !on || forwarded;
      return v_flex().id(id).px(12).py(7).gap(2).border_b(1).border_color(t.border).bg(hot ? t.hover : t.background)
        .on_hover((x, cx) => { view.hot = x ? id : view.hot === id ? null : view.hot; cx.notify(); })
        .when(Boolean(p.cmd), (e) => e.tooltip(p.cmd))
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().w(56).flex_none().font_family(MONO).font_semibold().text_size(12.5).child(`:${p.port}`))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(p.name ?? "?"))
          .when(Boolean(p.space), (e) => e.child(pill(p.space?.name || baseName(p.space?.folder), t.ansi4 ?? t.muted, t)))
          .when(Boolean(forwarded), (e) => e.child(pill("forwarded", t.ansi2, t)))
          .when(!p.open, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(p.addr === "127.0.0.1" || p.addr === "::1" ? "local" : p.addr))))
        .when(Boolean(p.cwd), (e) => e.child(div().pl(64).truncate().font_family(MONO).text_size(11).text_color(t.dim).child(tilde(p.cwd))))
        .when(asking, (e) => e.child(h_flex().gap(6).pt(3).pl(64).items_center()
          .child(div().flex_1().text_size(12).text_color(t.muted).child(`Stop ${p.name ?? "it"} (${p.pid})?`))
          .child(button(`pt-kill-${p.port}`, "Stop", t, (_e, cx) => this.kill(p, cx), { danger: true }))
          .child(button(`pt-no-${p.port}`, "Cancel", t, (_e, cx) => { this.ask = null; cx.notify(); }))))
        .when(hot && !asking, (e) => e.child(h_flex().gap(4).pt(3).pl(64)
          .child(reach ? button(`pt-open-${p.port}`, "Open", t, () => openUrl(`http://localhost:${p.port}`), { icon: "external", tooltip: `http://localhost:${p.port}` })
            : button(`pt-fwd-${p.port}`, "Forward & open", t, (_e, cx) => this.forward(p, cx), { icon: "link", tooltip: `ssh -L ${p.port}:localhost:${p.port}` }))
          .when(Boolean(forwarded) && (this.here.get(p.port)?.name ?? "").toLowerCase().includes("ssh"), (x) => x.child(button(`pt-unfwd-${p.port}`, "Stop forward", t, (_e, cx) => this.unforward(p, cx), { icon: "close" })))
          .child(div().flex_1())
          .when(Boolean(p.pid), (x) => x.child(button(`pt-ask-${p.port}`, "", t, (_e, cx) => { this.ask = p.port; cx.notify(); }, { icon: "stop", danger: true, tooltip: "Stop the process" })))));
    };
    const section = (label, n, extra = null) => h_flex().h(28).px(12).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .text_size(11).font_semibold().text_color(t.muted).child(label).child(div().text_color(t.dim).child(String(n))).child(div().flex_1()).when(Boolean(extra), (e) => e.child(extra));
    const note = this.note && Date.now() - this.note.at < 8000 ? this.note : null;
    return card(t, "pt", "Ports", `${title} · ${rows.length} listening`, tools,
      v_flex().flex_1().min_h(0)
        .when(Boolean(note), (e) => e.child(div().px(12).py(6).text_size(12).text_color(note.error ? t.ansi1 : t.muted).bg(t.raised).child(note.text)))
        .child(v_flex().id("pt-list").flex_1().min_h(0).overflow_y_scroll()
          .child(section("In your spaces", mine.length))
          .when(mine.length === 0, (e) => e.child(div().px(12).py(10).text_size(12).text_color(t.dim).child("No server runs in a space's folder.")))
          .children(mine.map(row))
          .child(section("Other", rest.length, button("pt-all", this.showAll ? "Hide" : "Show", t, (_e, cx) => { this.showAll = !this.showAll; cx.notify(); }, { invisible: true })))
          .when(this.showAll, (e) => e.children(rest.map(row)))));
  }
}
