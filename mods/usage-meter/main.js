// 사이드바 아래 한 줄: Claude / Codex(계정별) / opencode 주간 사용량을 링으로.
// 링 = 주간 사용%, 흰 눈금 = 주간 경과%(리셋까지 시간이 얼마나 흘렀는지), 숫자 색 = 페이스(Claude Code statusline의 Weekly 화살표와 같은 계산).
// 오른쪽 위 점 = 5h 창을 70% 이상 썼을 때만. 호버하면 창별 상세.
// Codex는 계정(email)별 auth.json 사본으로 로그아웃한 계정도 조회한다(아래 Codex 다중 계정 참고).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { theme, home, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";

const EVERY_MS = 5 * 60 * 1000;
const BRAND = { claude: "#d97757", codex: "#7a8cff", opencode: "#a8a8b3" };
// statusline 팔레트
const PACE = { teal: "#5ad8ce", soft: "#a8b0bc", red: "#d85a5a", yellow: "#d8bf5a", orange: "#d8955a" };
const ARROW = { up2: "⇈", up: "↑", flat: "→", down: "↓", down2: "⇊" };
const paceColor = (k) => (k === "up2" || k === "up" ? PACE.teal : k === "flat" ? PACE.soft : PACE.red);
const WINDOW_SECS = { "5h": 5 * 3600, "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
const RING_PX = 34;

// 링은 svg()로 그린다: 벡터라 줌에도 깨지지 않는다. svg()는 한 색(text_color)으로만 칠하므로
// 바탕 원(track) / 호(arc-<pct>) / 눈금(tick-<pct>)을 따로 파일로 두고 겹친다. 파일은 색과 무관.
// herdr-app 홈 기준 경로. mods/ 밖이라 써도 mod가 다시 불러와지지 않는다.
const RING_REL = "data/usage-meter/rings34";
const ringDir = () => `${appHome()}/${RING_REL}`;
const VB = 34, R = 15, STROKE = 3;
const arcName = (pct) => `arc-${pct}.svg`;
const tickName = (pct) => `tick-${pct}.svg`;
const TRACK = "track.svg";
const svgWrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${VB}" height="${VB}">${body}</svg>`;
const circle = (extra) => `<circle cx="${VB / 2}" cy="${VB / 2}" r="${R}" fill="none" stroke="#fff" stroke-width="${STROKE}"${extra}/>`;
const trackSvg = () => svgWrap(circle(""));
function arcSvg(pct) {
  if (pct <= 0) return svgWrap("");
  if (pct >= 100) return trackSvg();
  const c = 2 * Math.PI * R;
  return svgWrap(circle(` stroke-linecap="round" stroke-dasharray="${((c * pct) / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${VB / 2} ${VB / 2})"`));
}
function tickSvg(pct) {
  const a = (pct / 100) * 2 * Math.PI - Math.PI / 2, m = VB / 2;
  const p = (r) => [(m + r * Math.cos(a)).toFixed(2), (m + r * Math.sin(a)).toFixed(2)];
  const [x1, y1] = p(R - STROKE), [x2, y2] = p(R + STROKE * 0.6);
  return svgWrap(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`);
}
const STORE = "codex.accounts";

const OLD_LABEL = { "주": "7d", "월": "30d" };
const loadAccounts = () => {
  try {
    const a = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    for (const v of Object.values(a)) for (const w of v.windows ?? []) w.label = OLD_LABEL[w.label] ?? w.label;
    return a;
  } catch { return {}; }
};
const saveAccounts = (a) => localStorage.setItem(STORE, JSON.stringify(a));

const windowLabel = (secs) => secs <= 6 * 3600 ? "5h" : secs <= 26 * 3600 ? "1d" : "7d";

function untilText(ms) {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return d >= 10 ? `${d}d` : `${d}d ${h % 24}h`;
}
function agoText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// 창 하나의 남은 %. 리셋 시각이 지났으면 다 찼다고 본다.
const leftOf = (w, now) => (w.resetAt && w.resetAt <= now ? 100 : Math.max(0, Math.round(100 - w.used)));

async function readJson(path) {
  const text = await readTextFile(path);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": "herdr-usage-meter", ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function claudeUsage(h) {
  const creds = await readJson(`${h}/.claude/.credentials.json`);
  const o = creds?.claudeAiOauth;
  if (!o?.accessToken) return { error: "Not signed in" };
  if (o.expiresAt && o.expiresAt < Date.now()) return { error: "Token expired. Run claude to renew" };
  const d = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${o.accessToken}`, "anthropic-beta": "oauth-2025-04-20",
  });
  const windows = [];
  if (d.five_hour) windows.push({ label: "5h", used: d.five_hour.utilization ?? 0, resetAt: Date.parse(d.five_hour.resets_at) || null });
  if (d.seven_day) windows.push({ label: "7d", used: d.seven_day.utilization ?? 0, resetAt: Date.parse(d.seven_day.resets_at) || null });
  return { plan: o.subscriptionType ?? "", windows };
}

// ── Codex 다중 계정 ──────────────────────────────────────────────────────────
// ~/.codex/auth.json에 로그인된 계정을 볼 때마다 그 auth.json 사본을 SNAP_DIR/<email>.json에 둔다.
// 로그아웃한(사본만 있는) 계정도 사본 토큰으로 조회하고, 만료되면 refresh token으로 갱신해 사본에 다시 쓴다.
// 지금 ~/.codex에 로그인된 계정은 절대 갱신하지 않는다(갱신하면 refresh token이 바뀌어 Codex 쪽 로그인이 깨진다).
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const snapDir = () => `${appHome()}/data/usage-meter/codex`;
const snapPath = (email) => `${snapDir()}/${email.replace(/[^A-Za-z0-9._@-]/g, "_")}.json`;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function jwtClaims(token) {
  try {
    const s = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    let bits = 0, acc = 0, bytes = [];
    for (const ch of s) {
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
    }
    return JSON.parse(decodeURIComponent(bytes.map(b => "%" + b.toString(16).padStart(2, "0")).join("")));
  } catch { return null; }
}

function parseCodexUsage(d, fallbackEmail) {
  const windows = [];
  for (const w of [d.rate_limit?.secondary_window, d.rate_limit?.primary_window]) {
    if (!w) continue;
    windows.push({ label: windowLabel(w.limit_window_seconds), used: w.used_percent ?? 0, resetAt: w.reset_at ? w.reset_at * 1000 : null });
  }
  windows.sort((a, b) => (a.label === "5h" ? -1 : b.label === "5h" ? 1 : 0));
  return { email: d.email ?? fallbackEmail, plan: d.plan_type ?? "", windows, limitReached: Boolean(d.rate_limit?.limit_reached) };
}

const wham = (t) => fetchJson("https://chatgpt.com/backend-api/wham/usage", {
  Authorization: `Bearer ${t.access_token}`, "ChatGPT-Account-Id": t.account_id ?? "",
});

async function refreshTokens(auth) {
  const r = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "herdr-usage-meter" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token, scope: "openid profile email" }),
  });
  if (!r.ok) throw new Error(`Token refresh failed (HTTP ${r.status})`);
  const n = await r.json();
  return {
    ...auth,
    tokens: { ...auth.tokens, id_token: n.id_token ?? auth.tokens.id_token, access_token: n.access_token ?? auth.tokens.access_token, refresh_token: n.refresh_token ?? auth.tokens.refresh_token },
    last_refresh: new Date().toISOString(),
  };
}

// 사본 계정 하나: 만료 5분 전이면 미리 갱신, 401이면 한 번 갱신 후 재시도.
async function snapshotUsage(path, auth) {
  const exp = jwtClaims(auth.tokens.access_token)?.exp ?? 0;
  if (exp * 1000 < Date.now() + 5 * 60 * 1000) {
    auth = await refreshTokens(auth);
    await fs.writeFile(path, JSON.stringify(auth, null, 2));
  }
  try { return await wham(auth.tokens); }
  catch (e) {
    if (!String(e.message).includes("401")) throw e;
    auth = await refreshTokens(auth);
    await fs.writeFile(path, JSON.stringify(auth, null, 2));
    return wham(auth.tokens);
  }
}

// 반환: { current: email|null, results: { email: usage | {error} } }
async function codexUsage(h) {
  await fs.mkdir(snapDir(), { recursive: true });
  const results = {};
  let current = null;

  const authText = await readTextFile(`${h}/.codex/auth.json`);
  let auth = null;
  try { auth = authText ? JSON.parse(authText) : null; } catch {}
  if (auth?.tokens?.access_token) {
    const email = jwtClaims(auth.tokens.id_token)?.email ?? auth.tokens.account_id;
    current = email;
    // 로그인된 계정의 최신 auth.json을 사본으로 (Codex가 갱신하면 따라간다)
    await fs.writeFile(snapPath(email), authText);
    try { results[email] = parseCodexUsage(await wham(auth.tokens), email); }
    catch (e) { results[email] = { error: String(e.message ?? e) }; }
  }

  const files = (await fs.readdir(snapDir())).filter(f => f.endsWith(".json"));
  await Promise.all(files.map(async (f) => {
    const path = `${snapDir()}/${f}`;
    let snap = null;
    try { snap = JSON.parse(await fs.readFile(path, "utf8")); } catch { return; }
    if (!snap?.tokens?.refresh_token) return;
    const email = jwtClaims(snap.tokens.id_token)?.email ?? snap.tokens.account_id;
    if (email === current) return;
    try { results[email] = parseCodexUsage(await snapshotUsage(path, snap), email); }
    catch (e) { results[email] = { error: String(e.message ?? e) }; }
  }));
  return { current, results };
}

async function forgetSnapshot(email) {
  const p = snapPath(email);
  if (await fs.exists(p)) await fs.unlink(p);
}

// OpenCode Go 구독: 5h(rolling) / 주 / 월 사용률. 키가 없으면 OpenRouter 잔액으로.
async function opencodeUsage(h) {
  const auth = await readJson(`${h}/.local/share/opencode/auth.json`);
  // auth.json의 opencode / opencode-go 키 중 사용량 API가 받아 주는 쪽을 쓴다.
  const keys = [auth?.opencode?.key, auth?.["opencode-go"]?.key].filter(Boolean);
  if (!keys.length) return openrouterUsage(auth);
  let d = null, lastError = null;
  for (const key of keys) {
    try { d = await fetchJson("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${key}` }); break; }
    catch (e) { lastError = e; }
  }
  if (!d) throw lastError;
  const u = d?.usage ?? {};
  const windows = [["rolling", "5h"], ["weekly", "7d"], ["monthly", "30d"]]
    .filter(([k]) => u[k])
    .map(([k, label]) => ({ label, used: u[k].percent ?? 0, resetAt: Date.parse(u[k].resetsAt) || null }));
  return { go: true, windows };
}

async function openrouterUsage(auth) {
  const key = auth?.openrouter?.key;
  if (!key) return { error: "No OpenRouter key" };
  const [credits, info] = await Promise.all([
    fetchJson("https://openrouter.ai/api/v1/credits", { Authorization: `Bearer ${key}` }),
    fetchJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` }),
  ]);
  const balance = (credits?.data?.total_credits ?? 0) - (credits?.data?.total_usage ?? 0);
  const free = info?.data?.free_model_daily_requests ?? null;
  return { balance, free, freeTier: Boolean(info?.data?.is_free_tier) };
}


// 창 하나의 사용%. 리셋 시각이 지났으면 0으로 본다.
const usedOf = (w, now) => (w.resetAt && w.resetAt <= now ? 0 : Math.min(100, Math.max(0, Math.round(w.used))));

// statusline의 Weekly 페이스: 사용률과 경과율을 비교해 리셋 전에 남을지(⇈↑) 모자랄지(↓⇊).
function paceOf(w, now) {
  const secs = WINDOW_SECS[w.label];
  if (!secs || !w.resetAt) return null;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const t = w.resetAt <= now ? 0 : clamp(1 - (w.resetAt - now) / (secs * 1000));
  const u = clamp(usedOf(w, now) / 100);
  let ratio;
  if (u >= 1) ratio = 0;
  else if (t >= 1) ratio = Infinity;
  else {
    const current = t === 0 ? 0 : u / t;
    ratio = current === 0 ? Infinity : ((1 - u) / (1 - t)) / current;
  }
  const kind = ratio >= 2 ? "up2" : ratio > 1.2 ? "up" : ratio > 1 / 1.2 ? "flat" : ratio > 0.5 ? "down" : "down2";
  return { kind, used: Math.round(u * 100), elapsed: Math.round(t * 100) };
}

// 링에 쓸 대표 창: 주간 > 월간 > 마지막 창
const mainWindow = (a) => a.windows.find(w => w.label === "7d") ?? a.windows.find(w => w.label === "30d") ?? a.windows[a.windows.length - 1] ?? null;

// 5h 경고 색(70% 이상 썼을 때만)
function fiveHourColor(a, now) {
  const w = a.windows.find(x => x.label === "5h");
  if (!w) return null;
  const u = usedOf(w, now);
  return u >= 90 ? PACE.red : u >= 80 ? PACE.orange : u >= 70 ? PACE.yellow : null;
}

const windowName = (l) => ({ "5h": "5-hour", "1d": "Daily", "7d": "Weekly", "30d": "Monthly" }[l] ?? l);

export default class UsageMeter extends View {
  init(_props, cx) {
    this.claude = null;
    this.codexNow = null; // 지금 ~/.codex에 로그인된 계정 email
    this.codexError = null;
    this.accounts = loadAccounts();
    this.openrouter = null;
    this.loading = false;
    this.hot = null;
    this.ringReady = new Set();
    cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const h = home();
      const [c, x, o] = await Promise.allSettled([claudeUsage(h), codexUsage(h), opencodeUsage(h)]);
      this.claude = c.status === "fulfilled" ? c.value : { error: String(c.reason?.message ?? c.reason) };
      if (x.status === "fulfilled") {
        this.codexError = null;
        this.codexNow = x.value.current;
        for (const [email, r] of Object.entries(x.value.results)) {
          // 실패한 계정은 마지막 값을 두고 오류만 붙인다
          if (r.error) this.accounts[email] = { ...(this.accounts[email] ?? { windows: [], plan: "", at: 0 }), error: r.error };
          else this.accounts[email] = { ...r, at: Date.now(), error: null };
        }
        saveAccounts(this.accounts);
      } else this.codexError = String(x.reason?.message ?? x.reason);
      this.openrouter = o.status === "fulfilled" ? o.value : { error: String(o.reason?.message ?? o.reason) };
      this.loading = false;
      try { await this.writeRings(Date.now()); } catch (e) { console.log(`usage-meter rings: ${e}`); }
      cx.notify();
    });
  }

  // 링 하나 = 계정 하나.
  cells() {
    const c = this.claude;
    const o = this.openrouter;
    const emails = Object.keys(this.accounts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const claude = { key: "claude", name: "claude", title: "Claude", icon: "icons/claude.svg", color: BRAND.claude,
      plan: c?.plan ?? "", windows: c?.windows ?? [], note: !c ? "Loading" : c.error ?? null };
    const codex = emails.length
      ? emails.map(email => {
          const a = this.accounts[email];
          return { key: email, email, name: email.split("@")[0], title: "Codex", icon: "icons/codex.svg", color: BRAND.codex,
            plan: a.plan ?? "", windows: a.windows ?? [], live: email === this.codexNow, stale: Boolean(a.error),
            note: a.error ? `Update failed · as of ${a.at ? agoText(Date.now() - a.at) : "earlier"}` : null };
        })
      : [{ key: "codex", name: "codex", title: "Codex", icon: "icons/codex.svg", color: BRAND.codex, plan: "", windows: [],
          note: this.codexError ?? (this.loading ? "Loading" : "Run codex login to add an account") }];
    const opencode = { key: "opencode", name: "opencode", title: "opencode", icon: "icons/opencode.svg", tint: true, color: BRAND.opencode,
      ...(o?.go
        ? { plan: "go", windows: o.windows, note: null }
        : { plan: "openrouter", windows: [],
            note: !o ? "Loading" : o.error ? o.error : o.balance > 0 ? `$${o.balance.toFixed(2)} left` : o.free ? `${o.free.remaining}/${o.free.limit} free requests left` : "$0 left" }) };
    return [claude, ...codex, opencode];
  }

  // 그리기 전에 필요한 링 파일(바탕 원, 사용%별 호, 경과%별 눈금)을 써 둔다.
  async writeRings(now) {
    await fs.mkdir(ringDir(), { recursive: true });
    const want = new Map([[TRACK, trackSvg]]);
    for (const a of this.cells()) {
      for (const w of a.windows) { const u = usedOf(w, now); want.set(arcName(u), () => arcSvg(u)); }
      const p = mainWindow(a) && paceOf(mainWindow(a), now);
      if (p) want.set(tickName(p.elapsed), () => tickSvg(p.elapsed));
    }
    for (const [name, make] of want) {
      if (this.ringReady.has(name)) continue;
      const path = `${ringDir()}/${name}`;
      if (!(await fs.exists(path))) await fs.writeFile(path, make());
      this.ringReady.add(name);
    }
  }

  forget(email, cx) {
    delete this.accounts[email];
    saveAccounts(this.accounts);
    cx.notify();
    cx.spawn(async () => { await forgetSnapshot(email); });
  }

  render() {
    const t = theme();
    const now = Date.now();

    const icon = (a, px) => a.tint
      ? svg(a.icon).size(px).flex_none().text_color(t.muted)
      : image(a.icon).size(px).flex_none();

    const layer = (file, color, px) => svg(`${RING_REL}/${file}`).size(px).absolute().top(0).left(0).text_color(color);
    // 링: 바탕 원 + 호 + (눈금) 위에 숫자. used가 null이면 "–".
    const ring = ({ used, arcColor, elapsed = null, numColor, px, fontPx, dot = null }) => {
      const arc = used === null ? null : arcName(used);
      const tick = elapsed === null ? null : tickName(elapsed);
      return div().size(px).flex_none().relative()
        .when(this.ringReady.has(TRACK), e => e.child(layer(TRACK, t.border, px)))
        .when(Boolean(arc) && this.ringReady.has(arc), e => e.child(layer(arc, arcColor, px)))
        .when(Boolean(tick) && this.ringReady.has(tick), e => e.child(layer(tick, t.foreground, px)))
        .child(div().size(px).absolute().top(0).left(0).flex().items_center().justify_center()
          .text_size(fontPx).font_semibold().text_color(numColor ?? t.foreground)
          .child(used === null ? "–" : String(used)))
        .when(Boolean(dot), e => e.child(div().size(9).absolute().top(-1).right(-1).rounded_full()
          .bg(dot).border(1.5).border_color(t.chrome)));
    };

    const smallRing = (w, color) => {
      const u = usedOf(w, now);
      return ring({ used: u, arcColor: u >= 90 ? PACE.red : u >= 75 ? PACE.yellow : color, px: 16, fontPx: 7 });
    };

    const popover = (a) => {
      const main = mainWindow(a);
      const head = h_flex().gap(6).items_center().mb(6)
        .child(icon(a, 13))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(a.title))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child([a.email ? a.name : null, a.plan, a.live ? "signed in" : null].filter(Boolean).join(" · ")));
      const rows = a.windows.map(w => {
        const p = w === main ? paceOf(w, now) : null;
        const reset = !w.resetAt ? null : w.resetAt <= now ? "reset" : untilText(w.resetAt - now);
        const value = p
          ? h_flex().gap(4).items_center()
              .child(div().font_semibold().text_color(paceColor(p.kind)).child(ARROW[p.kind]))
              .child(div().text_color(t.foreground).child(`${p.used}% / ${p.elapsed}%`))
          : div().text_color(t.foreground).child(`${usedOf(w, now)}%`);
        return h_flex().h(26).px(8).gap(8).mt(4).items_center().rounded(6).bg(t.raised).text_size(11.5)
          .child(smallRing(w, a.color))
          .child(div().text_color(t.muted).child(windowName(w.label)))
          .child(div().flex_1())
          .child(value)
          .when(Boolean(reset), e => e.child(div().text_color(t.dim).child(`· ${reset}`)));
      });
      const note = a.note ? div().mt(6).text_size(11).text_color(a.stale ? PACE.yellow : t.muted).child(a.note) : null;
      const legend = main ? "Used % / time elapsed % of the window" : null;
      return v_flex().w(260).mb(6).px(12).py(10).rounded(10).border(1).border_color(t.border).bg(t.popover).shadow_lg()
        .child(head).children(rows)
        .when(Boolean(note), e => e.child(note))
        .child(div().mt(8).text_size(10.5).text_color(t.dim)
          .child([legend, "Click to refresh", a.email ? "Right-click to remove" : null].filter(Boolean).join(" · ")));
    };

    const cell = (a) => {
      const main = mainWindow(a);
      const p = main ? paceOf(main, now) : null;
      const used = main ? usedOf(main, now) : null;
      const trigger = v_flex().id(`cell-${a.key}`).w_full().py(4).gap(4).items_center().rounded(8)
        .when(this.hot === a.key, e => e.bg(t.hover))
        .when(Boolean(a.stale), e => e.opacity(0.45))
        .on_hover((on, cx) => { if (on) this.hot = a.key; else if (this.hot === a.key) this.hot = null; cx.notify(); })
        .on_click((_e, cx) => this.refresh(cx))
        .when(Boolean(a.email), e => e.on_mouse_down("right", (_e, cx) => this.forget(a.email, cx)))
        .child(ring({ used, arcColor: a.color, elapsed: p?.elapsed ?? null, numColor: p ? paceColor(p.kind) : null,
          px: RING_PX, fontPx: 13, dot: fiveHourColor(a, now) }))
        .child(h_flex().gap(3).items_center().max_w_full()
          .child(icon(a, 11))
          .child(div().text_size(10.5).text_color(t.muted).truncate().child(a.name)));
      return div().flex_1().min_w_0().child(HoverCard.new(`pop-${a.key}`).anchor("bottom_center").open_delay(250).close_delay(150)
        .trigger(trigger)
        .content(this.hot !== a.key ? div() : popover(a)));
    };

    return h_flex().id("usage-root").size_full().bg(t.chrome).border_t(1).border_color(t.border).px(6).pt(4).items_center()
      .children(this.cells().map(cell));
  }
}
