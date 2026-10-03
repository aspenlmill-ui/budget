import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_URL = "https://aspenlmill-ui.github.io/budget/";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const supabase = createClient(SUPABASE_URL, secretKeys.default, { auth: { persistSession: false, autoRefreshToken: false } });
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, VAPID_PUBLIC_KEY, Deno.env.get("VAPID_PRIVATE_KEY")!);
// The shared secret lives in Supabase Vault; only the service role can read it.
let CRON_SECRET: string | null = null;
async function cronSecret() {
  if (!CRON_SECRET) { const { data } = await supabase.rpc("wb_cron_secret"); CRON_SECRET = typeof data === "string" && data.length >= 32 ? data : null; }
  return CRON_SECRET;
}
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

const DAY = 864e5;
const dn = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const money = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BASE = ["household", "aspen", "grace", "extras"];

function localNow(tz?: string) {
  let zone = tz || "America/New_York";
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "America/New_York"; }
  const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
}

// Status by how much of a card is left (% of what it has this period); lower cutoffs in the last days before refill. Mirrors the app.
// deno-lint-ignore no-explicit-any
function pctStatus(left: number, alloc: number, th: any, end: boolean) {
  const pl = left / alloc * 100;
  return pl >= (end ? th.fireEnd : th.fire) ? "fire" : pl >= (end ? th.goodEnd : th.good) ? "good" : "warn";
}
// deno-lint-ignore no-explicit-any
function poolStatus(x: any, s: any) {
  if (x.left < -0.004) return (x.short != null ? x.short <= 0.004 : x.cushion + x.left >= 0) ? "warn" : "bad";
  if (x.alloc <= 0) return "good";
  if (x.alloc > 40 && x.left <= 20) return "warn";
  return pctStatus(x.left, x.alloc, s.th, s.end);
}
// deno-lint-ignore no-explicit-any
function overall(out: any, pools: string[], s: any) {
  const st = pools.map((p) => poolStatus(out[p], s));
  if (st.includes("bad")) return "\u2604\ufe0f"; if (st.includes("warn")) return "\ud83e\uddb4";
  const left = pools.reduce((a, p) => a + out[p].left, 0), alloc = pools.reduce((a, p) => a + out[p].alloc, 0);
  const r = alloc > 0 ? pctStatus(left, alloc, s.th, s.end) : "good";
  return r === "fire" ? "\ud83c\udf0b" : r === "warn" ? "\ud83e\uddb4" : "\ud83e\udd96";
}
// deno-lint-ignore no-explicit-any
function summarize(settings: any, txns: any[], moves: any[], events: any[], today: string) {
  const t = dn(today), a = dn(settings.anchor || today);
  // deno-lint-ignore no-explicit-any
  const segs: any[] = settings.periods?.length ? settings.periods : [{ from: settings.anchor || today, kind: "week" }];
  const kindAt = (x: number) => { let k = segs[0].kind; for (const g of segs) if (dn(g.from) <= x) k = g.kind; return k; };
  const nextAfter = (x: number) => { const k = kindAt(x); if (k === "biweek") return x + 14; if (k === "month") { const d = new Date(x * DAY); return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY); } return x + 7; };
  const man = [...(settings.starts || []), ...segs.slice(1).map((g) => g.from)].map(dn).filter((x: number) => x > a).sort((x: number, y: number) => x - y);
  const step = (x: number) => { const nx = nextAfter(x); const m = man.find((y: number) => y > x && y < nx); return m !== undefined ? m : nx; };
  const L: number[] = []; let w = a;
  while (w <= t) { L.push(w); w = step(w); }
  if (!L.length) L.push(a);
  const cw = L[L.length - 1], next = step(cw);
  const wk = (s: string) => { const n = dn(s); let r = L[0]; for (const x of L) { if (x <= n) r = x; else break; } return r; };
  const hist = [...(settings.history || [])].sort((x, y) => dn(x.from) - dn(y.from));
  const budgetFor = (p: string, wn: number) => { let b = 0; for (const e of hist) if (dn(e.from) <= wn) b = +e[p] || 0; return b; };
  const customs = (settings.custom || []).filter((c: any) => !c.archived);
  const pools = [...BASE, ...customs.map((c: any) => c.id)];
  // deno-lint-ignore no-explicit-any
  const R: Record<string, any> = {};
  for (const p of pools) R[p] = { adj: {}, spent: {}, cush: 0 };
  for (const x of txns) { const r = R[x.pool]; if (!r) continue; const amt = +x.amount;
    if (x.src === "cushion") r.cush -= amt; else { const k = wk(x.date); r.spent[k] = (r.spent[k] || 0) + amt; } }
  const ap = (ep: string, amt: number, k: number) => { const [kind, p] = ep.split(":"); if (!R[p]) return;
    if (kind === "week") R[p].adj[k] = (R[p].adj[k] || 0) + amt; else if (kind === "cushion") R[p].cush += amt;
    else if (kind === "next") { const nx = step(k); R[p].adj[nx] = (R[p].adj[nx] || 0) + amt; } };
  for (const m of moves) { const k = wk(m.date); ap(m.from_ep, -m.amount, k); ap(m.to_ep, +m.amount, k); }
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  // Period end: leftovers go to splurge; overspending is covered by splurge (the card's own first, then the others'),
  // and only what all splurge can't cover comes off the next period. Mirrors settle() in the app.
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const settle = (lefts: Record<string, number>, cush: Record<string, number>) => {
    const carry: Record<string, number> = {};
    for (const p of pools) if (lefts[p] > 0) cush[p] += lefts[p];
    for (const p of pools) { let d = -lefts[p]; if (!(d > 0.004)) continue;
      const order = [p, ...pools.filter((q) => q !== p).sort((a, b) => cush[b] - cush[a])];
      for (const q of order) { if (d <= 0.004) break; const t = Math.min(d, Math.max(0, cush[q])); if (t > 0.004) { cush[q] -= t; d -= t; } }
      if (d > 0.004) carry[p] = r2(d); }
    for (const p of pools) cush[p] = r2(cush[p]);
    return carry; };
  const cush: Record<string, number> = {}, carry: Record<string, Record<number, number>> = {};
  for (const p of pools) { cush[p] = R[p].cush; carry[p] = {}; }
  for (const x of L) { if (x >= cw) continue; const lefts: Record<string, number> = {};
    for (const p of pools) lefts[p] = budgetFor(p, x) + (R[p].adj[x] || 0) - (carry[p][x] || 0) - (R[p].spent[x] || 0);
    const cr = settle(lefts, cush), nx = step(x);
    for (const p in cr) carry[p][nx] = (carry[p][nx] || 0) + cr[p]; }
  const lefts: Record<string, number> = {};
  for (const p of pools) { const r = R[p];
    const alloc = budgetFor(p, cw) + (r.adj[cw] || 0) - (carry[p][cw] || 0), spent = r.spent[cw] || 0;
    lefts[p] = alloc - spent;
    out[p] = { left: alloc - spent, cushion: cush[p], alloc, spent }; }
  const proj = settle(lefts, { ...cush }), pos = pools.reduce((s, p) => s + Math.max(0, cush[p]), 0);
  for (const p of pools) { out[p].nextBudget = budgetFor(p, next) + (R[p].adj[next] || 0) - (proj[p] || 0); out[p].short = Math.max(0, -lefts[p] - pos); }
  const names = { household: "Household", aspen: "Me", grace: "Partner", extras: "Extras", ...(settings.names || {}) };
  for (const c of customs) names[c.id] = c.name;
  const ev = events.filter((e) => e.active).map((e) => {
    const key = "event:" + e.id; let b = +e.budget || 0;
    for (const m of moves) { if (m.to_ep === key) b += +m.amount; if (m.from_ep === key) b -= +m.amount; }
    const s = txns.filter((x) => x.pool === key).reduce((s2, x) => s2 + +x.amount, 0);
    return { name: e.name, left: b - s };
  });
  const th = { fire: 60, good: 25, fireEnd: 30, goodEnd: 10, days: 2, ...(settings.statusTh || {}) };
  return { th, end: next - t <= th.days, out, names, customs, ev, cwDate: new Date(cw * DAY).toISOString().slice(0, 10), full: !!settings.partnerFull, hide: settings.partnerHide || [], resetTomorrow: next === t + 1, frac: Math.min(1, Math.max(0, (t - cw + 1) / Math.max(1, next - cw))) };
}

// 5 PM check. Bills you pay yourself: asked on the due date, or 2 days before month end if there is no due date.
// Bills whose amount varies: reminded 2 days before month end to enter the amount.
// deno-lint-ignore no-explicit-any
function billDay(b: any) { const d = parseInt(String(b.day || "").replace(/\D/g, ""), 10); return d >= 1 && d <= 31 ? d : null; }
// deno-lint-ignore no-explicit-any
function autopayOn(b: any) { return billDay(b) !== null && (b.variable ? b.auto === true : b.auto !== false); }
// deno-lint-ignore no-explicit-any
function manualDue(plan: any, today: string) {
  const t = dn(today), [Y, M, D] = today.split("-").map(Number), paid = new Set(plan.paid || []), sn = plan.snooze || {}, va = plan.varAmt || {};
  const last = new Date(Date.UTC(Y, M, 0)).getUTCDate(), me = D >= last - 2, phase = plan.postClosing ? "post" : "pre";
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const b of plan.bills || []) {
    if (!(b.phase === "both" || b.phase === phase || !b.phase)) continue;
    const d = billDay(b), ap = autopayOn(b);
    for (const off of [0, -1]) {
      const y = M + off < 1 ? Y - 1 : Y, m = (M - 1 + off + 12) % 12, key = `${b.name}|${y}-${String(m + 1).padStart(2, "0")}`;
      if (sn[key] === today) continue;
      const due = d === null ? null : Math.round(Date.UTC(y, m, Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) / DAY);
      if (due !== null && b.added && dn(b.added) > due) continue;
      // deno-lint-ignore no-explicit-any
      const pl = (plan.paidLog || []).find((x: any) => x.key === key), part = !!pl && !paid.has(key);
      const est = Math.max(0, (va[key] != null ? +va[key] : +b.amt || 0) - (part ? +pl.amount || 0 : 0));
      if (off === 0 && !paid.has(key) && !ap && (due === null ? me : (due <= t && (due >= t - 7 || me)))) out.push({ name: b.name, due, amt: est, ask: "paid", vary: !!b.variable, part });
      else if (off === -1 && d !== null && !paid.has(key) && !ap && due !== null && due >= t - 7) out.push({ name: b.name, due, amt: est, ask: "paid", vary: !!b.variable, part });
      else if (off === 0 && b.variable && paid.has(key) && va[key] == null && me) out.push({ name: b.name, due, amt: est, ask: "amount", vary: true });
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function billCheck(subs: any[], force: boolean, only: string | null, sample = "") {
  let sent = 0, skipped = 0, removed = 0;
  const done = new Set<string>();
  for (const sub of subs ?? []) {
    if (only && sub.user_id !== only) continue;
    const now = localNow(sub.tz);
    if (!force && !done.has(sub.user_id)) {
      const { data: already } = await supabase.from("notification_send_log").select("id").eq("user_id", sub.user_id).eq("local_date", now.date).eq("notification_type", "bill_check").maybeSingle();
      if (already) { skipped++; continue; }
    }
    const { data: member } = await supabase.from("household_members").select("household_id").eq("user_id", sub.user_id).maybeSingle();
    if (!member?.household_id) continue;
    const hid = member.household_id;
    const [{ data: hh }, { data: st }, { data: pl }] = await Promise.all([
      supabase.from("households").select("created_by").eq("id", hid).maybeSingle(),
      supabase.from("wb_settings").select("data").eq("household_id", hid).maybeSingle(),
      supabase.from("wb_plan").select("data").eq("household_id", hid).maybeSingle(),
    ]);
    const canSee = hh?.created_by === sub.user_id || !!st?.data?.partnerFull;
    if (!canSee || !pl?.data) continue;
    const due = sample ? [{ name: sample === "amount" ? "Enbridge gas (test)" : "Electric (test)", due: dn(now.date), amt: 120, ask: sample === "amount" ? "amount" : "paid", vary: true, part: false }] : manualDue(pl.data, now.date);
    if (!due.length) continue;
    const t = dn(now.date);
    const title = due.length > 1 ? `${due.length} bills to check` : due[0].ask === "amount" ? `What was ${due[0].name} this month?` : `Did you pay ${due[0].name}?`;
    const fmt = (x: number) => new Date(x * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const body = due.map((x) => x.ask === "amount" ? `${x.name}: enter this month's amount` : `${x.name}: ${x.part ? "" : x.vary ? "about " : ""}${money(x.amt)}${x.part ? " still due" : ""}${x.due === null ? " this month" : x.due < t ? " (was due " + fmt(x.due) + ")" : " due today"}`).join("\n") + "\nTap to update it in the app.";
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, JSON.stringify({ notification: { title, body, tag: `bills-${now.date}${sample}`, navigate: APP_URL + "#bills" } }), { TTL: 6 * 3600 });
      sent++;
      if (!force && !done.has(sub.user_id)) { done.add(sub.user_id); await supabase.from("notification_send_log").insert({ user_id: sub.user_id, local_date: now.date, notification_type: "bill_check" }); }
    } catch (e: any) {
      const status = e?.statusCode ?? e?.status;
      if (status === 404 || status === 410 || (status === 400 && String(e?.body || "").includes("VapidPkHashMismatch"))) { await supabase.from("push_subscriptions").delete().eq("id", sub.id); removed++; }
      else console.error(e);
    }
  }
  return { kind: "bills", sent, skipped, removed };
}

// Alerts: one push when a card first drops into Raptor alert, and one if it goes over (Extinction event).
// Each card + level alerts once per budget period, between 8 AM and 9 PM local time.
// deno-lint-ignore no-explicit-any
async function alertCheck(subs: any[], force: boolean, only: string | null) {
  let sent = 0, removed = 0;
  // deno-lint-ignore no-explicit-any
  const cache: Record<string, any> = {};
  for (const sub of subs ?? []) {
    if (only && sub.user_id !== only) continue;
    const now = localNow(sub.tz);
    if (!force && (now.hour < 8 || now.hour > 21)) continue;
    const { data: member } = await supabase.from("household_members").select("household_id").eq("user_id", sub.user_id).maybeSingle();
    if (!member?.household_id) continue;
    const hid = member.household_id, ck = hid + "|" + now.date;
    if (!(ck in cache)) {
      const [{ data: hh }, { data: st }, { data: tx }, { data: mv }] = await Promise.all([
        supabase.from("households").select("created_by").eq("id", hid).maybeSingle(),
        supabase.from("wb_settings").select("data").eq("household_id", hid).maybeSingle(),
        supabase.from("wb_txns").select("pool,amount,src,date").eq("household_id", hid),
        supabase.from("wb_moves").select("from_ep,to_ep,amount,date").eq("household_id", hid),
      ]);
      cache[ck] = st?.data ? { owner: hh?.created_by, s: summarize(st.data, tx ?? [], mv ?? [], [], now.date) } : null;
    }
    const c = cache[ck];
    if (!c) continue;
    const isOwner = c.owner === sub.user_id, s = c.s;
    const pools: string[] = isOwner || s.full ? [...BASE, ...s.customs.map((x: any) => x.id)] : ["grace", ...(s.hide.includes("household") ? [] : ["household"])];
    const mine = isOwner ? "aspen" : "grace";
    for (const p of pools) {
      const x = s.out[p]; if (!x) continue;
      const stt = poolStatus(x, s);
      if (stt !== "warn" && stt !== "bad") continue;
      const type = `alert:${p}:${stt}`;
      if (!force) {
        const { data: already } = await supabase.from("notification_send_log").select("id").eq("user_id", sub.user_id).eq("local_date", s.cwDate).eq("notification_type", type).maybeSingle();
        if (already) continue;
      }
      const name = p === mine ? "Your money" : s.names[p];
      const title = stt === "bad" ? `\u2604\ufe0f Extinction event: ${name}` : `\ud83e\uddb4 Raptor alert: ${name}`;
      const body = x.left < 0 ? `${name} is ${money(-x.left)} over this week.${x.short <= 0.004 ? " Splurge money can cover it." : " Move money or pause spending."}`
        : `${name} has ${money(x.left)} left of ${money(x.alloc)}. Tread carefully.`;
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, JSON.stringify({ notification: { title, body, tag: `alert-${p}-${s.cwDate}`, navigate: APP_URL } }), { TTL: 6 * 3600 });
        sent++;
        if (!force) await supabase.from("notification_send_log").insert({ user_id: sub.user_id, local_date: s.cwDate, notification_type: type });
      } catch (e: any) {
        const status = e?.statusCode ?? e?.status;
        if (status === 404 || status === 410 || (status === 400 && String(e?.body || "").includes("VapidPkHashMismatch"))) { await supabase.from("push_subscriptions").delete().eq("id", sub.id); removed++; break; }
        else console.error(e);
      }
    }
  }
  return { kind: "alerts", sent, removed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("key") === "1") return Response.json({ publicKey: VAPID_PUBLIC_KEY }, { headers: cors });
  // Instant check right after someone logs a purchase: signed-in user, only their own household.
  if (url.searchParams.get("kind") === "alerts-now") {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await supabase.auth.getUser(tok);
    if (!u?.user) return new Response("Unauthorized", { status: 401, headers: cors });
    const { data: mem } = await supabase.from("household_members").select("household_id").eq("user_id", u.user.id).maybeSingle();
    if (!mem?.household_id) return Response.json({ ok: true }, { headers: cors });
    const { data: ms } = await supabase.from("household_members").select("user_id").eq("household_id", mem.household_id);
    const ids = (ms ?? []).map((m) => m.user_id);
    const { data: hs } = await supabase.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth_key,tz").in("user_id", ids);
    return Response.json({ ok: true, ...(await alertCheck(hs ?? [], false, null)) }, { headers: cors });
  }
  const secret = await cronSecret();
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("Unauthorized", { status: 401 });

  const force = url.searchParams.get("force") === "1";
  const only = url.searchParams.get("user");
  const kind = url.searchParams.get("kind");
  const { data: allSubs, error } = await supabase.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth_key,tz");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  // Each phone gets its own 5 PM bill check and 7 PM balance, in its own time zone.
  const at = (h: number) => (allSubs ?? []).filter((x) => localNow(x.tz).hour === h);
  const bills = force ? (kind === "bills" || kind === "sample" ? await billCheck(allSubs ?? [], true, only, kind === "sample" ? (url.searchParams.get("ask") || "paid") : "") : null) : await billCheck(at(17), false, only);
  if (force && (kind === "bills" || kind === "sample")) return Response.json({ ok: true, ...bills });
  if (force && kind === "alerts") return Response.json({ ok: true, ...(await alertCheck(allSubs ?? [], true, only)) });
  const alerts = force ? null : await alertCheck(allSubs ?? [], false, only);
  const subs = force ? (allSubs ?? []) : at(19);
  let sent = 0, skipped = 0, removed = 0, failed = 0;
  const cache: Record<string, unknown> = {};
  const sentToday = new Set<string>();

  for (const sub of subs ?? []) {
    if (only && sub.user_id !== only) continue;
    const now = localNow(sub.tz);
    if (!force && !sentToday.has(sub.user_id)) {
      const { data: already } = await supabase.from("notification_send_log").select("id").eq("user_id", sub.user_id).eq("local_date", now.date).eq("notification_type", "weekly_balance").maybeSingle();
      if (already) { skipped++; continue; }
    }
    const { data: member } = await supabase.from("household_members").select("household_id").eq("user_id", sub.user_id).maybeSingle();
    if (!member?.household_id) { failed++; continue; }
    const hid = member.household_id;
    const ck = hid + "|" + now.date;
    if (!(ck in cache)) {
      const [{ data: hh }, { data: st }, { data: tx }, { data: mv }, { data: ev }] = await Promise.all([
        supabase.from("households").select("created_by").eq("id", hid).maybeSingle(),
        supabase.from("wb_settings").select("data").eq("household_id", hid).maybeSingle(),
        supabase.from("wb_txns").select("pool,amount,src,date").eq("household_id", hid),
        supabase.from("wb_moves").select("from_ep,to_ep,amount,date").eq("household_id", hid),
        supabase.from("wb_events").select("id,name,budget,active").eq("household_id", hid),
      ]);
      if (!st?.data) { cache[ck] = null; } else cache[ck] = { owner: hh?.created_by, s: summarize(st.data, tx ?? [], mv ?? [], ev ?? [], now.date) };
    }
    // deno-lint-ignore no-explicit-any
    const c = cache[ck] as any;
    if (!c) { failed++; continue; }
    const isOwner = c.owner === sub.user_id;
    const { out, names, hide, resetTomorrow } = c.s;
    // Nightly: just your own money and Household.
    const pools: string[] = isOwner ? ["aspen", "household"] : ["grace", ...(hide.includes("household") ? [] : ["household"])];
    const label = (p: string) => (p === (isOwner ? "aspen" : "grace") ? "My Money" : names[p]);
    let title: string, body: string;
    if (resetTomorrow) {
      title = "Budgets refill tomorrow";
      const rp = isOwner ? [...pools, "grace"] : pools;
      body = rp.map((p) => `${label(p)}: add ${money(Math.max(0, out[p].nextBudget - out[p].left))} (${money(out[p].left)} left → splurge)`).join("\n");
    } else {
      title = `${overall(out, pools, c.s)} Tomorrow’s starting balance`;
      body = pools.map((p) => `${label(p)}: ${money(out[p].left)}${out[p].left < 0 ? " (over)" : ""}`).join("\n");
    }
    const payload = JSON.stringify({ notification: { title, body, tag: `weekly-budget-${now.date}`, navigate: APP_URL } });
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, payload, { TTL: 3600 });
      sent++;
      if (!force && !sentToday.has(sub.user_id)) {
        sentToday.add(sub.user_id);
        await supabase.from("notification_send_log").insert({ user_id: sub.user_id, local_date: now.date, notification_type: "weekly_balance" });
      }
    } catch (e: any) {
      const status = e?.statusCode ?? e?.status;
      if (status === 404 || status === 410 || (status === 400 && String(e?.body || "").includes("VapidPkHashMismatch"))) { await supabase.from("push_subscriptions").delete().eq("id", sub.id); removed++; }
      else { console.error(e); failed++; }
    }
  }
  return Response.json({ ok: true, bills, alerts, sent, skipped, removed, failed, force });
});
