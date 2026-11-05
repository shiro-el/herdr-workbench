// Machine: how busy the focused space's machine is (or one picked here): CPU, memory, disks, GPUs, and the
// heaviest processes. Read every few seconds while it shows.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { machines, theme } from "herdr";
import { follow, location, shownView, sh, run, lines, card, empty, button, spinner, meter, bytes, span, isWindows, MONO } from "./common.js";

const SYNC = 4000;

const LINUX = `export LC_ALL=C
head -n1 /proc/stat; echo @@
nproc; echo @@
cat /proc/loadavg; echo @@
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; echo @@
cut -d' ' -f1 /proc/uptime; echo @@
df -P -B1 / "$HOME" 2>/dev/null | tail -n +2 | sort -u; echo @@
ps -eo pid=,user=,pcpu=,pmem=,rss=,etimes=,comm= --sort=-pcpu | head -n 8; echo @@
ps -eo pid=,user=,pcpu=,pmem=,rss=,etimes=,comm= --sort=-rss | head -n 8; echo @@
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits; echo @@
hostname; uname -sr; whoami`;

const WINDOWS = `$os = Get-CimInstance Win32_OperatingSystem
$raw = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { @{ mount = $_.DeviceID; size = [double]$_.Size; used = [double]($_.Size - $_.FreeSpace) } })
$procs = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 7 | ForEach-Object { @{ pid = $_.Id; comm = $_.ProcessName; rss = [double]$_.WorkingSet64; cpu = [double]$_.CPU } })
@{ idle = [double]$raw.PercentProcessorTime; ts = [double]$raw.Timestamp_Sys100NS; n = [Environment]::ProcessorCount; memTotal = [double]$os.TotalVisibleMemorySize * 1024; memAvail = [double]$os.FreePhysicalMemory * 1024
   up = ((Get-Date) - $os.LastBootUpTime).TotalSeconds; disks = $disks; procs = $procs; host = $env:COMPUTERNAME; os = $os.Caption; user = $env:USERNAME } | ConvertTo-Json -Compress -Depth 4`;

function parseLinux(out, prev) {
  const s = out.replace(/\r/g, "").split("@@\n");
  const ticks = (s[0] ?? "").trim().split(/\s+/).slice(1).map(Number);
  const idle = (ticks[3] ?? 0) + (ticks[4] ?? 0), total = ticks.reduce((a, b) => a + b, 0);
  const cpu = prev?.ticks && total > prev.ticks.total ? 100 * (1 - (idle - prev.ticks.idle) / (total - prev.ticks.total)) : null;
  const mem = Object.fromEntries(lines(s[3]).map((l) => { const [k, v] = l.split(/:\s+/); return [k, Number.parseInt(v, 10) * 1024]; }));
  const proc = (l) => { const [pid, user, pcpu, pmem, rss, et, ...comm] = l.trim().split(/\s+/); return { pid, user, cpu: Number(pcpu), mem: Number(pmem), rss: Number(rss) * 1024, age: Number(et), comm: comm.join(" ") }; };
  const [host, kernel, user] = lines(s[9]);
  return {
    ticks: { idle, total }, cpu, n: Number(lines(s[1])[0]) || null,
    load: (s[2] ?? "").trim().split(/\s+/).slice(0, 3).map(Number),
    memTotal: mem.MemTotal, memAvail: mem.MemAvailable, swapTotal: mem.SwapTotal, swapFree: mem.SwapFree,
    up: Number(lines(s[4])[0]),
    disks: lines(s[5]).map((l) => { const f = l.trim().split(/\s+/); return { mount: f[5], size: Number(f[1]), used: Number(f[2]) }; }),
    byCpu: lines(s[6]).map(proc), byMem: lines(s[7]).map(proc),
    gpus: lines(s[8]).map((l) => { const [i, name, util, used, total, temp] = l.split(/,\s*/); return { i, name, util: Number(util), used: Number(used) * 1048576, total: Number(total) * 1048576, temp: Number(temp) }; }),
    host, kernel, user,
  };
}

// CPU from two readings of the idle counter (Win32_Processor's LoadPercentage samples for a second itself).
function parseWindows(out, prev) {
  const j = JSON.parse(out), ticks = { idle: j.idle, total: j.ts };
  const cpu = prev?.ticks && ticks.total > prev.ticks.total ? Math.min(100, Math.max(0, 100 * (1 - (ticks.idle - prev.ticks.idle) / (ticks.total - prev.ticks.total)))) : null;
  const procs = (j.procs ?? []).map((p) => ({ pid: String(p.pid), user: "", cpu: null, mem: j.memTotal ? 100 * p.rss / j.memTotal : null, rss: p.rss, age: null, comm: p.comm, cpuSecs: p.cpu }));
  return { ticks, cpu, n: j.n, load: null, memTotal: j.memTotal, memAvail: j.memAvail, up: j.up, disks: (j.disks ?? []).filter((d) => d.size > 0),
    byCpu: null, byMem: procs, gpus: [], host: j.host, kernel: j.os, user: j.user };
}

export class Machine {
  constructor(view, cx) {
    this.view = view;
    this.pick = undefined; // undefined: follow the focused space; null: this computer; else a machine's name
    this.data = {}; this.error = {}; this.busy = new Set(); this.sort = "cpu"; this.ask = null; this.note = null;
    cx.timer.every(SYNC, (cx) => { if (shownView() === "machine") this.refresh(cx, true); });
    follow(cx, "machine", () => String(this.on()), (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  on() { return this.pick === undefined ? location().on : this.pick; }

  get loading() { return this.busy.has(this.on() ?? ""); }

  // One reading per machine at a time; another machine's doesn't wait for it. A first reading has no CPU yet
  // (it's the change between two), so a second follows at once.
  refresh(cx, quiet = false) {
    const on = this.on(), key = on ?? "";
    if (this.busy.has(key)) return;
    this.busy.add(key); if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      const local = !on && isWindows();
      const r = local ? await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS]) : await sh(LINUX, [], on ? { on } : {});
      this.busy.delete(key);
      let again = false;
      try {
        if (r.code !== 0 && !r.stdout) throw new Error((r.stderr || "Couldn't read the machine").trim().split("\n").pop());
        const d = local ? parseWindows(r.stdout, this.data[key]) : parseLinux(r.stdout, this.data[key]);
        if (d.cpu == null && this.data[key]?.cpu != null) d.cpu = this.data[key].cpu;
        again = d.cpu == null && !this.data[key]?.ticks;
        this.data[key] = d;
        delete this.error[key];
      } catch (e) { this.error[key] = String(e?.message ?? e); }
      cx.notify();
      if (again) { await cx.sleep(local ? 300 : 500); if ((this.on() ?? "") === key) this.refresh(cx, true); }
    });
  }

  kill(p, cx) {
    const on = this.on();
    this.ask = null;
    cx.spawn(async (cx) => {
      const r = !on && isWindows() ? await run("taskkill", ["/PID", p.pid]) : await run("kill", [p.pid], on ? { on } : {});
      this.note = { text: r.code === 0 ? `Stopped ${p.comm} (${p.pid})` : (r.stderr || "kill failed").trim().split("\n").pop(), error: r.code !== 0, at: Date.now() };
      this.refresh(cx, true);
    });
  }

  render(cx) {
    const t = theme(), view = this.view;
    const on = this.on(), key = on ?? "", d = this.data[key], err = this.error[key];
    const names = [null, ...machines().map((m) => m.name).filter(Boolean)];
    const chip = (name) => {
      const sel = (this.pick === undefined ? location().on ?? null : this.pick) === name;
      return h_flex().id(`mc-pick-${name ?? "here"}`).h(22).px(8).flex_none().items_center().rounded(6).text_size(11.5)
        .bg(sel ? t.selected : t.background).text_color(sel ? t.foreground : t.muted).border_1().border_color(sel ? t.border : "#00000000")
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pick = name; this.refresh(cx); })
        .child(name ?? "This computer");
    };
    const tools = [
      this.pick !== undefined ? button("mc-follow", "Follow", t, (_e, cx) => { this.pick = undefined; this.refresh(cx); }, { invisible: true, tooltip: "Follow the focused space's machine" }) : null,
      this.loading ? h_flex().px(5).child(spinner(13, t.muted)) : button("mc-refresh", "", t, (_e, cx) => this.refresh(cx), { icon: "refresh", invisible: true, tooltip: "Refresh" }),
    ].filter(Boolean);
    const picker = h_flex().px(10).py(6).gap(4).flex_wrap().border_b(1).border_color(t.border).children(names.map(chip));
    const title = d?.host ?? on ?? "This computer";
    if (!d) return card(t, "mc", title, null, tools, v_flex().flex_1().min_h(0).child(picker)
      .child(err ? empty(t, "Couldn't read the machine", err, [button("mc-retry", "Retry", t, (_e, cx) => this.refresh(cx), { icon: "refresh" })]) : empty(t, "Reading…", null)));

    const memUsed = d.memTotal - d.memAvail;
    const sub = [d.kernel, d.up ? `up ${span(d.up)}` : null].filter(Boolean).join(" · ");
    const procs = (this.sort === "cpu" && d.byCpu) ? d.byCpu : d.byMem ?? [];
    const gauges = v_flex().px(12).py(10).gap(10).border_b(1).border_color(t.border)
      .child(meter(t, `CPU${d.n ? ` · ${d.n} cores` : ""}`, d.cpu ?? 0, 100, d.cpu == null ? "…" : `${d.cpu.toFixed(0)}%${d.load ? `  load ${d.load.map((x) => x.toFixed(2)).join(" ")}` : ""}`))
      .child(meter(t, "Memory", memUsed, d.memTotal, `${bytes(memUsed)} / ${bytes(d.memTotal)}`))
      .when(d.swapTotal > 0, (e) => e.child(meter(t, "Swap", d.swapTotal - d.swapFree, d.swapTotal, `${bytes(d.swapTotal - d.swapFree)} / ${bytes(d.swapTotal)}`)))
      .children((d.disks ?? []).map((k) => meter(t, `Disk ${k.mount}`, k.used, k.size, `${bytes(k.used)} / ${bytes(k.size)}`)))
      .children((d.gpus ?? []).map((g) => v_flex().gap(6)
        .child(meter(t, `GPU ${g.i} · ${g.name}`, g.util, 100, `${g.util}%  ${g.temp}°C`))
        .child(meter(t, `GPU ${g.i} memory`, g.used, g.total, `${bytes(g.used)} / ${bytes(g.total)}`))));

    const sortChip = (k, label) => h_flex().id(`mc-sort-${k}`).h(20).px(7).items_center().rounded(5).text_size(11)
      .bg(this.sort === k ? t.selected : "#00000000").text_color(this.sort === k ? t.foreground : t.muted)
      .cursor_pointer().on_click((_e, cx) => { this.sort = k; cx.notify(); }).child(label);
    const head = h_flex().h(30).px(12).gap(4).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("Processes"))
      .when(Boolean(d.byCpu), (e) => e.child(sortChip("cpu", "CPU")).child(sortChip("mem", "Memory")));
    const proc = (p) => {
      const id = `mc:${p.pid}`, hot = view.hot === id, asking = this.ask === p.pid, mine = !p.user || p.user === d.user;
      return v_flex().id(id).px(12).py(5).border_b(1).border_color(t.border).bg(hot ? t.hover : t.background)
        .on_hover((x, cx) => { view.hot = x ? id : view.hot === id ? null : view.hot; cx.notify(); })
        .child(h_flex().gap(8).items_center().text_size(12)
          .child(div().flex_1().min_w(0).truncate().child(p.comm))
          .when(Boolean(p.user) && !mine, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(p.user)))
          .when(p.cpu != null, (e) => e.child(div().w(46).flex_none().text_right().font_family(MONO).text_size(11).text_color(p.cpu > 100 ? t.blocked : t.muted).child(`${p.cpu.toFixed(0)}%`)))
          .child(div().w(62).flex_none().text_right().font_family(MONO).text_size(11).text_color(t.muted).child(bytes(p.rss)))
          .when(hot && mine && !asking, (e) => e.child(button(`mc-ask-${p.pid}`, "", t, (_e, cx) => { this.ask = p.pid; cx.notify(); }, { icon: "stop", danger: true, invisible: true, tooltip: `Stop ${p.pid}` }))))
        .when(hot && !asking, (e) => e.child(div().text_size(10.5).text_color(t.dim).font_family(MONO).child(`pid ${p.pid}${p.age != null ? ` · ${span(p.age)}` : ""}`)))
        .when(asking, (e) => e.child(h_flex().gap(6).pt(3).items_center()
          .child(div().flex_1().text_size(12).text_color(t.muted).child(`Stop ${p.comm} (${p.pid})?`))
          .child(button(`mc-kill-${p.pid}`, "Stop", t, (_e, cx) => this.kill(p, cx), { danger: true }))
          .child(button(`mc-no-${p.pid}`, "Cancel", t, (_e, cx) => { this.ask = null; cx.notify(); }))));
    };
    const note = this.note && Date.now() - this.note.at < 8000 ? this.note : null;
    return card(t, "mc", title, sub, tools,
      v_flex().id("mc-body").flex_1().min_h(0).overflow_y_scroll()
        .child(picker)
        .when(Boolean(err), (e) => e.child(div().px(12).py(6).text_size(12).text_color(t.ansi1).child(err)))
        .when(Boolean(note), (e) => e.child(div().px(12).py(6).text_size(12).text_color(note.error ? t.ansi1 : t.muted).bg(t.raised).child(note.text)))
        .child(gauges).child(head).children(procs.map(proc)));
  }
}
