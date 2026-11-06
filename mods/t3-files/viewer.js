// The floating viewer (a `kind: "window"` overlay): a title bar to drag it by, the file below. Markdown and
// CSV/TSV show rendered, with their source a click away; HTML shows as Chromium draws it (page.js, a picture of the
// whole page), its source, its structure (no CSS), or the real page in the browser through a server on the file's
// machine (serve.js); a picture shows as itself. Text is edited in Source and saved with Ctrl+S; a file an agent
// changes reloads by itself, or, with unsaved changes, shows a mark that offers to reload.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, TextView } from "gpui-base";
import { exec, theme, props, closeOverlay, appHome, window, focused, readTextFile, setShared } from "herdr";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import { materialIcon, readPreview, openFloat, copyPath, saveText } from "./util.js";
import { ensure, stop, prune, servers, serverKey, pageUrl, openBrowser } from "./serve.js";
import { shoot, shootUrl, dropShot } from "./page.js";

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const MAX_IMAGE = 6 * 1024 * 1024; // exec carries 8 MiB of output; base64 is a third bigger
const ROWS = 1000, COLS = 40;
const unBom = (s) => (typeof s === "string" && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function kindOf(path) {
  const ext = (path.includes(".") ? path.split(".").pop() : "").toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (IMAGES.has(ext)) return "image";
  return "text";
}

// RFC 4180-ish: quotes, doubled quotes, newlines inside quotes. `;` when the first line has it and no comma.
function parseTable(text, tsv) {
  const first = text.slice(0, text.indexOf("\n") >>> 0);
  const sep = tsv ? "\t" : !first.includes(",") && first.includes(";") ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length && rows.length <= ROWS; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// A picture is shown from the app's folder only: copied into cache/t3-files, named by its content.
// macOS has shasum where Linux and Git Bash have sha1sum; its older base64 decodes with -D.
async function cacheImage(root, path, on) {
  const ext = "." + path.split(".").pop().toLowerCase(), full = `${root}/${path}`, dir = `${appHome()}/cache/t3-files`;
  await fs.mkdir(dir, { recursive: true });
  if (!on) {
    const r = await exec("sh", ["-c", 'h=$( (sha1sum "$1" 2>/dev/null || shasum "$1") | cut -c1-16) && [ -n "$h" ] && cp "$1" "$2/$h$3" && echo "$h"', "sh", full, dir, ext]);
    if (r.code !== 0) throw new Error(r.stderr || "Couldn't copy the picture");
    return `cache/t3-files/${r.stdout.trim()}${ext}`;
  }
  const size = Number((await exec("sh", ["-c", 'wc -c < "$1"', "sh", full], { on })).stdout.trim());
  if (size > MAX_IMAGE) throw new Error(`Too big to show here (${(size / 1048576).toFixed(1)} MB)`);
  const r = await exec("sh", ["-c", 'base64 < "$1"', "sh", full], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Couldn't read the picture");
  const b64 = r.stdout.replace(/\s+/g, ""), name = createHash("sha256").update(b64).digest("hex").slice(0, 16);
  // This runtime writes bytes as an empty file: the text goes down, this computer's base64 decodes it.
  const tmp = `${dir}/${name}.b64`, out = `${dir}/${name}${ext}`;
  await fs.writeFile(tmp, b64);
  const d = await exec("sh", ["-c", '{ base64 -d < "$1" > "$2" 2>/dev/null || base64 -D < "$1" > "$2"; } && rm -f "$1"', "sh", tmp, out]);
  if (d.code !== 0) throw new Error(d.stderr || "Couldn't decode the picture");
  return `cache/t3-files/${name}${ext}`;
}

// A link in rendered Markdown: the web opens in the browser; a file of the project opens here.
function follow(url, v) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return openBrowser(url);
  const [target] = url.split("#");
  if (!target) return;
  const parts = (target.startsWith("/") ? target.slice(1) : [...v.path.split("/").slice(0, -1), target].join("/")).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(decodeURIComponent(p)); }
  openFloat(v.root, out.join("/"), v.on, false);
}

export class Viewer {
  constructor(v, cx) {
    // local change: { url } is a web page (t3-spotlight opens those): Page mode only.
    this.v = v; this.kind = v.url ? "web" : kindOf(v.path);
    this.mode = this.kind === "md" || this.kind === "csv" ? "render" : this.kind === "html" || this.kind === "web" ? "page" : "source";
    this.handle = cx.focus_handle(); this.handle.focus();
    this.space = focused()?.space ?? null; // the space it was opened in: it closes when another is shown
    this.serving = null; this.note = null;
    if (this.kind === "html") cx.spawn(async (cx) => { await prune(v.root, v.on); cx.notify(); });
    this.page = null; // { busy } | { image, width, height, cut } | { error }
    if (this.kind === "html" || this.kind === "web") this.capture(cx);
    if (this.kind === "web") { this.loaded = true; return; }
    // Editing: `base` is the editor's text as last loaded or saved, `disk` the file's as last seen. `stale`: it
    // changed on disk under unsaved changes; `gone`: it was deleted.
    this.dirty = false; this.stale = false; this.gone = false;
    cx.spawn(async (cx) => {
      if (this.kind === "image") {
        try { this.picture = await cacheImage(v.root, v.path, v.on); } catch (e) { this.error = String(e?.message ?? e); }
      } else {
        const r = await readPreview(v.root, v.path, v.on, true);
        this.code = r.code ?? null; this.text = r.text ?? null; this.error = r.error ?? null;
        this.editable = Boolean(r.editable); this.why = r.why ?? null; this.bom = Boolean(r.bom); this.legacy = Boolean(r.legacy);
        if (this.code) {
          this.base = this.code.value(); this.disk = this.text; this.crlf = this.text.includes("\r\n");
          this.code.on("change", (_e, cx) => this.edited(cx));
        }
        if (this.kind === "csv" && this.text != null) this.table = parseTable(this.text, this.tsv());
      }
      this.loaded = true; cx.notify();
    });
    if (this.kind !== "image") cx.timer.every(v.on ? 4000 : 1500, (cx) => this.check(cx));
  }

  close() {
    if (this.v.slot && this.dirty) setShared("t3-files.view-dirty", false);
    this.code?.release?.(); this.closed = true; dropShot(this.page?.image);
  }

  tsv() { return this.v.path.toLowerCase().endsWith(".tsv"); }
  full() { return `${this.v.root}/${this.v.path}`; }
  dirtyNow() { return Boolean(this.code && this.editable) && this.code.value() !== this.base; }

  edited(cx) {
    const d = this.dirtyNow();
    if (d === this.dirty) return;
    this.dirty = d;
    if (this.v.slot) setShared("t3-files.view-dirty", d); // so a click elsewhere opens a window of its own
    cx.notify();
  }

  // The file as it is on disk: its text, null when it's gone, undefined when it couldn't be read this time.
  readRaw() { return readTextFile(this.full(), { on: this.v.on }).catch(() => undefined); }

  // An agent changed the file: reload it, or with unsaved changes, mark it.
  check(cx) {
    if (!this.code || this.legacy || this.checking || this.saving || this.closed) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await this.readRaw();
        if (raw === undefined || this.closed || this.saving) return;
        if (raw === null) { if (!this.gone) { this.gone = true; cx.notify(); } return; }
        const now = unBom(raw), was = this.gone;
        this.gone = false;
        if (now === this.disk) { if (was) cx.notify(); return; }
        this.disk = now;
        if (!this.dirtyNow()) this.reload(now, cx);
        else if (now === this.code.value()) { this.base = now; this.stale = false; this.edited(cx); }
        else this.stale = true;
        cx.notify();
      } finally { this.checking = false; }
    });
  }

  reload(text, cx) {
    this.disk = text; this.text = text; this.stale = false; this.askReload = false; this.gone = false;
    this.code.set_value(text); this.base = this.code.value(); this.crlf = text.includes("\r\n");
    if (this.kind === "csv") this.table = parseTable(text, this.tsv());
    this.edited(cx);
    if (this.kind === "html" && this.page) this.capture(cx);
    cx.notify();
  }

  // Ctrl+S. A change on disk not yet shown is marked first; once marked, saving goes over it.
  save(cx, then) {
    if (!this.editable || this.saving) return;
    if (!this.dirtyNow() && !this.gone) return void then?.();
    this.saving = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const raw = await this.readRaw();
        if (typeof raw === "string" && unBom(raw) !== this.disk && !this.stale) {
          this.disk = unBom(raw); this.stale = true;
          this.note = "Changed on disk while you were editing. Ctrl+S again saves yours over it.";
          return;
        }
        const mine = this.code.value(), out = this.crlf ? mine.replace(/\r?\n/g, "\r\n") : mine;
        await saveText(this.full(), (this.bom ? "\ufeff" : "") + out, typeof raw === "string" ? raw : null, this.v.on, this.stale);
        this.disk = out; this.text = mine; this.base = mine; this.stale = false; this.gone = false; this.askReload = false;
        if (this.kind === "csv") this.table = parseTable(mine, this.tsv());
        if (this.kind === "html" && this.page) this.capture(cx);
        this.edited(cx);
        then?.();
      } catch (e) {
        // Written between the read and the save: marked, and the next Ctrl+S saves over it.
        if (String(e?.message) === "CHANGED") { this.stale = true; this.note = "Changed on disk while saving. Ctrl+S again saves yours over it."; }
        else this.note = `Couldn't save: ${String(e?.message ?? e)}`;
      }
      finally { this.saving = false; cx.notify(); }
    });
  }

  // Closing with unsaved changes asks first.
  requestClose(cx) {
    if (this.dirtyNow()) { this.confirming = true; cx.notify(); }
    else closeOverlay(props()?.overlay);
  }

  // Draws the page again (after an edit, say); the old picture stays until the new one is there.
  capture(cx) {
    if (this.page?.busy) return;
    const v = this.v, old = this.page;
    this.page = { ...(old?.image ? old : {}), busy: true }; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const got = v.url ? await shootUrl(v.url) : await shoot(v.root, v.path, v.on, cx);
        if (this.closed) return void dropShot(got.image);
        this.page = got;
        if (old?.image) dropShot(old.image);
      } catch (e) { this.page = { error: String(e?.message ?? e) }; if (old?.image) dropShot(old.image); }
      cx.notify();
    });
  }

  browse(cx) {
    const v = this.v;
    if (v.url) return void openBrowser(v.url);
    this.serving = "starting"; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const port = await ensure(v.root, v.on, cx);
        this.serving = port;
        openBrowser(pageUrl(port, v.path));
      } catch (e) { this.serving = null; this.note = String(e?.message ?? e); }
      cx.notify();
    });
  }

  stopServing(cx) {
    cx.spawn(async (cx) => { await stop(this.v.root, this.v.on); this.serving = null; cx.notify(); });
  }

  body(t) {
    const msg = (m) => div().p(14).text_color(t.dim).child(m);
    if (this.error) return msg(this.error);
    if (!this.loaded) return msg("Loading file…");
    if (this.kind === "image") return div().id("viewer-image").flex_1().min_h(0).p(16).flex().items_center().justify_center().overflow_hidden()
      .bg(t.canvas).child(image(this.picture).size_full()); // GPUI fits a picture inside its box, keeping its shape
    if (this.mode === "page" && (this.kind === "html" || this.kind === "web")) {
      const p = this.page ?? {};
      if (p.error) return msg(p.error);
      if (!p.image) return msg("Chromium is drawing the page…");
      return v_flex().id("viewer-page").flex_1().min_h(0).overflow_y_scrollbar().bg("#ffffff")
        .child(image(p.image).w(p.width).h(p.height).flex_none())
        .when(p.cut, (e) => e.child(div().p(10).text_size(12).text_color("#666666").child(`The page goes on; the first ${p.height} px are shown`)));
    }
    if (this.mode === "render" && this.kind === "md") return v_flex().id("viewer-md").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(18)
      .child(TextView.markdown("viewer-md-text", (this.editable ? this.code.value() : this.text) ?? "").selectable(true).on_link_click((url) => follow(url, this.v)));
    if (this.mode === "render" && this.kind === "html") return v_flex().id("viewer-html").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(18)
      .child(TextView.html("viewer-html-text", this.text ?? "").selectable(true).on_link_click((url) => follow(url, this.v)));
    if (this.mode === "render" && this.kind === "csv") return this.tableView(t);
    return this.code ? Editor.new(this.code).flex_1().min_h(0) : msg("");
  }

  tableView(t) {
    const rows = this.table ?? [], cols = Math.min(COLS, Math.max(0, ...rows.map((r) => r.length)));
    const cell = (text, head, i) => div().w(150).flex_none().px(8).py(5).border_r(1).border_color(t.border).truncate()
      .text_size(12).when(head, (e) => e.font_semibold()).child(text ?? "");
    const line = (r, i) => h_flex().id(`row-${i}`).flex_none().border_b(1).border_color(t.border).bg(i === 0 ? t.raised : i % 2 ? t.background : t.surface ?? t.background)
      .child(div().w(44).flex_none().px(6).py(5).text_size(11).text_color(t.dim).text_right().child(i === 0 ? "" : String(i)))
      .children(Array.from({ length: cols }, (_, c) => cell(r[c], i === 0, c)));
    return v_flex().flex_1().min_h(0)
      .child(div().id("viewer-table").flex_1().min_h(0).overflow_scroll()
        .child(v_flex().flex_none().children(rows.slice(0, ROWS + 1).map(line))))
      .child(h_flex().h(24).flex_none().px(10).items_center().text_size(11).text_color(t.dim).border_t(1).border_color(t.border)
        .child(String(Math.max(0, rows.length - 1)) + " rows · " + cols + " columns" + (rows.length > ROWS ? " · first " + ROWS + " shown" : "")));
  }

  render(cx) {
    // Another space shown: this one's file goes with its space.
    const now = focused()?.space ?? null;
    if (this.space && now && now !== this.space && !this.leaving && !this.dirtyNow()) {
      this.leaving = true;
      const id = props()?.overlay;
      cx.spawn(async () => closeOverlay(id));
    }
    const t = theme(), v = this.v, web = this.kind === "web";
    const host = web ? (/^[a-z]+:\/\/([^/?#]+)/i.exec(v.url)?.[1] ?? v.url) : null;
    const name = web ? host : v.path.split("/").pop(), dir = web ? v.url : v.path.includes("/") ? v.path.slice(0, v.path.lastIndexOf("/")) : "";
    const stopPress = (_e, cx) => cx.stop_propagation();
    const tool = (id, child, tip, act) => div().id(id).h(24).min_w(24).px(child && typeof child === "string" && child.length > 2 ? 8 : 0).flex_none().flex().items_center().justify_center().rounded(6)
      .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stopPress).on_click(act).child(child);
    const close = (_e, cx) => this.requestClose(cx);
    const modes = this.kind === "md" || this.kind === "csv" ? [["render", this.kind === "csv" ? "Table" : "Preview"], ["source", "Source"]]
      : this.kind === "html" ? [["page", "Page"], ["source", "Source"], ["render", "Structure"]] : [];
    const seg = h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.background).border_1().border_color(t.border)
      .children(modes.map(([m, label]) => div().id(`mode-${m}`).h(20).px(8).flex().items_center().rounded(5).text_size(11.5)
        .bg(this.mode === m ? t.selected : "#00000000").text_color(this.mode === m ? t.foreground : t.muted)
        .cursor_pointer().on_mouse_down("left", stopPress).on_click((_e, cx) => {
          this.mode = m;
          if (m === "render" && this.kind === "csv" && this.editable) this.table = parseTable(this.code.value(), this.tsv());
          cx.notify();
        }).child(label)));
    const button = (id, label, act, strong) => div().id(id).h(22).px(10).flex_none().flex().items_center().rounded(6).text_size(12)
      .bg(strong ? t.solid : t.background).text_color(strong ? t.solid_foreground : t.foreground).border_1().border_color(strong ? t.solid : t.border)
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_mouse_down("left", stopPress).on_click(act).child(label);
    const bar = (id, text, color, ...buttons) => h_flex().id(id).flex_none().px(12).py(6).gap(8).items_center().bg(t.raised)
      .border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).text_color(color).child(text)).children(buttons);
    const dirty = this.dirtyNow();
    const running = web ? null : servers()[serverKey(v.root, v.on)];
    return v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => {
        const m = e.modifiers ?? {};
        if (e.key === "escape") { if (this.confirming) { this.confirming = false; cx.notify(); } else this.requestClose(cx); }
        else if (e.key === "s" && (m.control || m.platform) && !m.alt && !m.shift) { cx.stop_propagation(); this.save(cx); }
      })
      .child(h_flex().h(38).flex_none().pl(12).pr(6).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(image(`mods/t3-files/material/${materialIcon(web ? "page.html" : name, false, false)}.svg`).size(16).flex_none())
        .child(div().flex_none().max_w(260).truncate().font_semibold().child(name))
        .when(dirty || this.saving, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.muted).child(this.saving ? "Saving…" : "●")))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child([v.on, dir].filter(Boolean).join(" · ")))
        .when(modes.length > 0, (e) => e.child(seg))
        .when((this.kind === "html" || web) && this.mode === "page", (e) => e.child(tool("viewer-redraw", this.page?.busy ? "…" : "↻",
          "Draw the page again", (_e, cx) => this.capture(cx))))
        .when(web, (e) => e.child(tool("viewer-browse", "Open in browser", "Opens the page in this computer's browser", (_e, cx) => this.browse(cx))))
        .when(this.kind === "html", (e) => e.child(tool("viewer-browse", this.serving === "starting" ? "Starting…" : "Open in browser",
          v.on ? `Serves ${v.root} on ${v.on} (127.0.0.1), forwards it here, opens the page` : `Serves ${v.root} here (127.0.0.1) and opens the page`,
          (_e, cx) => this.browse(cx))))
        .when(Boolean(running), (e) => e.child(tool("viewer-stop", `:${running.port} ■`, "Stop the server (and its tunnel)", (_e, cx) => this.stopServing(cx))))
        .when(this.stale || this.gone, (e) => e.child(tool("viewer-stale", div().text_color(t.ansi3).child("⚠"),
          this.gone ? "Deleted on disk. Ctrl+S saves it again" : "Changed on disk. Click to reload it",
          (_e, cx) => { this.askReload = !this.askReload; cx.notify(); })))
        .child(tool("viewer-copy", "⧉", web ? "Copy address" : "Copy path", () => copyPath(web ? v.url : `${v.root}/${v.path}`)))
        .child(tool("viewer-close", svg("mods/t3-files/x.svg").size(13), "Close (Esc)", close)))
      .when(Boolean(this.confirming), (e) => e.child(bar("viewer-confirm", `Unsaved changes in ${name}.`, t.foreground,
        button("confirm-save", "Save", (_e, cx) => { this.confirming = false; this.save(cx, () => closeOverlay(props()?.overlay)); }, true),
        button("confirm-discard", "Discard", () => closeOverlay(props()?.overlay)),
        button("confirm-cancel", "Cancel", (_e, cx) => { this.confirming = false; cx.notify(); }))))
      .when(Boolean(this.askReload && this.stale), (e) => e.child(bar("viewer-reload", "Changed on disk while you were editing. Ctrl+S saves yours over it.", t.foreground,
        button("reload", "Reload from disk", (_e, cx) => this.reload(this.disk, cx)))))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).text_size(12).text_color(t.ansi1).bg(t.raised).child(this.note)))
      .when(Boolean(this.why) && this.mode === "source", (e) => e.child(div().px(12).py(4).flex_none().text_size(11.5).text_color(t.dim)
        .border_b(1).border_color(t.border).child(this.why)))
      .child(div().id("viewer-body").flex_1().min_h(0).flex().flex_col().on_mouse_down("left", stopPress).child(this.body(t)));
  }
}
