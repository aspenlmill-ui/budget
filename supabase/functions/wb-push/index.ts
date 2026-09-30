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

// deno-lint-ignore no-explicit-any
function poolStatus(x: any, frac: number) {
  if (x.left < -0.004) return x.cushion + x.left >= 0 ? "warn" : "bad";
  if (x.alloc <= 0) return "good";
  const used = x.spent / x.alloc;
  if (used >= 0.9 && frac < 0.85) return "warn";
  if (used > frac + 0.15) return "warn";
  if (frac >= 0.3 && used <= frac * 0.7) return "fire";
  return "good";
}
// deno-lint-ignore no-explicit-any
function overall(out: any, pools: string[], frac: number) {
  const st = pools.map((p) => poolStatus(out[p], frac));
  if (st.includes("bad")) return "🔴"; if (st.includes("warn")) return "🟡";
  const spent = pools.reduce((s, p) => s + out[p].spent, 0), alloc = pools.reduce((s, p) => s + out[p].alloc, 0);
  if (frac >= 0.3 && alloc > 0 && spent / alloc <= frac * 0.7) return "🔥";
  return "🦖";
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
  for (const p of pools) { const r = R[p]; let c = r.cush;
    for (const x of L) if (x < cw) c += budgetFor(p, x) + (r.adj[x] || 0) - (r.spent[x] || 0);
    const alloc = budgetFor(p, cw) + (r.adj[cw] || 0), spent = r.spent[cw] || 0;
    out[p] = { left: alloc - spent, cushion: c, nextBudget: budgetFor(p, next) + (r.adj[next] || 0), alloc, spent }; }
  const names = { household: "Household", aspen: "Me", grace: "Partner", extras: "Extras", ...(settings.names || {}) };
  for (const c of customs) names[c.id] = c.name;
  const ev = events.filter((e) => e.active).map((e) => {
    const key = "event:" + e.id; let b = +e.budget || 0;
    for (const m of moves) { if (m.to_ep === key) b += +m.amount; if (m.from_ep === key) b -= +m.amount; }
    const s = txns.filter((x) => x.pool === key).reduce((s2, x) => s2 + +x.amount, 0);
    return { name: e.name, left: b - s };
  });
  return { out, names, customs, ev, hide: settings.partnerHide || [], resetTomorrow: next === t + 1, frac: Math.min(1, Math.max(0, (t - cw + 1) / Math.max(1, next - cw))) };
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
      const est = va[key] != null ? +va[key] : +b.amt || 0;
      if (off === 0 && !paid.has(key) && !ap && (due === null ? me : (due <= t && (due >= t - 7 || me)))) out.push({ name: b.name, due, amt: est, ask: "paid", vary: !!b.variable });
      else if (off === -1 && d !== null && !paid.has(key) && !ap && due !== null && due >= t - 7) out.push({ name: b.name, due, amt: est, ask: "paid", vary: !!b.variable });
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
    const due = sample ? [{ name: sample === "amount" ? "Enbridge gas (test)" : "Electric (test)", due: dn(now.date), amt: 120, ask: sample === "amount" ? "amount" : "paid", vary: true }] : manualDue(pl.data, now.date);
    if (!due.length) continue;
    const t = dn(now.date);
    const title = due.length > 1 ? `${due.length} bills to check` : due[0].ask === "amount" ? `What was ${due[0].name} this month?` : `Did you pay ${due[0].name}?`;
    const fmt = (x: number) => new Date(x * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const body = due.map((x) => x.ask === "amount" ? `${x.name}: enter this month's amount` : `${x.name}: ${x.vary ? "about " : ""}${money(x.amt)}${x.due === null ? " this month" : x.due < t ? " (was due " + fmt(x.due) + ")" : " due today"}`).join("\n") + "\nTap to update it in the app.";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("key") === "1") return Response.json({ publicKey: VAPID_PUBLIC_KEY }, { headers: cors });
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
    const { out, names, hide, resetTomorrow, frac } = c.s;
    // Nightly: just your own money and Household.
    const pools: string[] = isOwner ? ["aspen", "household"] : ["grace", ...(hide.includes("household") ? [] : ["household"])];
    const label = (p: string) => (p === (isOwner ? "aspen" : "grace") ? "My Money" : names[p]);
    let title: string, body: string;
    if (resetTomorrow) {
      title = "Budgets refill tomorrow";
      body = pools.map((p) => `${label(p)}: add ${money(out[p].nextBudget - out[p].left)} (${money(out[p].left)} left → splurge)`).join("\n");
    } else {
      title = `${overall(out, pools, frac)} Tomorrow’s starting balance`;
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
  return Response.json({ ok: true, bills, sent, skipped, removed, failed, force });
});
