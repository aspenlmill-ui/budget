import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_URL = "https://aspenlmill-ui.github.io/budget/";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const supabase = createClient(SUPABASE_URL, secretKeys.default, { auth: { persistSession: false, autoRefreshToken: false } });
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, VAPID_PUBLIC_KEY, Deno.env.get("VAPID_PRIVATE_KEY")!);
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

const DAY = 864e5;
const dn = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const money = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BASE = ["household", "aspen", "grace", "extras"];

function easternNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
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
  return "🟢";
}
// deno-lint-ignore no-explicit-any
function summarize(settings: any, txns: any[], moves: any[], events: any[], today: string) {
  const t = dn(today), a = dn(settings.anchor || today);
  const man = (settings.starts || []).map(dn).filter((x: number) => x > a).sort((x: number, y: number) => x - y);
  const L: number[] = []; let w = a;
  while (w <= t) { L.push(w); let nx = w + 7; const m = man.find((x: number) => x > w && x < nx); if (m !== undefined) nx = m; w = nx; }
  if (!L.length) L.push(a);
  const cw = L[L.length - 1], next = cw + 7;
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
    if (kind === "week") R[p].adj[k] = (R[p].adj[k] || 0) + amt; else if (kind === "cushion") R[p].cush += amt; };
  for (const m of moves) { const k = wk(m.date); ap(m.from_ep, -m.amount, k); ap(m.to_ep, +m.amount, k); }
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const p of pools) { const r = R[p]; let c = r.cush;
    for (const x of L) if (x < cw) c += budgetFor(p, x) + (r.adj[x] || 0) - (r.spent[x] || 0);
    const alloc = budgetFor(p, cw) + (r.adj[cw] || 0), spent = r.spent[cw] || 0;
    out[p] = { left: alloc - spent, cushion: c, nextBudget: budgetFor(p, next), alloc, spent }; }
  const names = { household: "Household", aspen: "Me", grace: "Partner", extras: "Extras", ...(settings.names || {}) };
  for (const c of customs) names[c.id] = c.name;
  const ev = events.filter((e) => e.active).map((e) => {
    const key = "event:" + e.id; let b = +e.budget || 0;
    for (const m of moves) { if (m.to_ep === key) b += +m.amount; if (m.from_ep === key) b -= +m.amount; }
    const s = txns.filter((x) => x.pool === key).reduce((s2, x) => s2 + +x.amount, 0);
    return { name: e.name, left: b - s };
  });
  return { out, names, customs, ev, resetTomorrow: next === t + 1, frac: Math.min(1, Math.max(0, (t - cw + 1) / Math.max(1, next - cw))) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("key") === "1") return Response.json({ publicKey: VAPID_PUBLIC_KEY }, { headers: cors });
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("Unauthorized", { status: 401 });

  const now = easternNow();
  const force = url.searchParams.get("force") === "1";
  const only = url.searchParams.get("user");
  if (!force && now.hour !== 19) return Response.json({ ok: true, skipped: true, eastern: now });

  const { data: subs, error } = await supabase.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth_key");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  let sent = 0, skipped = 0, removed = 0, failed = 0;
  const cache: Record<string, unknown> = {};
  const sentToday = new Set<string>();

  for (const sub of subs ?? []) {
    if (only && sub.user_id !== only) continue;
    if (!force && !sentToday.has(sub.user_id)) {
      const { data: already } = await supabase.from("notification_send_log").select("id").eq("user_id", sub.user_id).eq("local_date", now.date).eq("notification_type", "weekly_balance").maybeSingle();
      if (already) { skipped++; continue; }
    }
    const { data: member } = await supabase.from("household_members").select("household_id").eq("user_id", sub.user_id).maybeSingle();
    if (!member?.household_id) { failed++; continue; }
    const hid = member.household_id;
    if (!cache[hid]) {
      const [{ data: hh }, { data: st }, { data: tx }, { data: mv }, { data: ev }] = await Promise.all([
        supabase.from("households").select("created_by").eq("id", hid).maybeSingle(),
        supabase.from("wb_settings").select("data").eq("household_id", hid).maybeSingle(),
        supabase.from("wb_txns").select("pool,amount,src,date").eq("household_id", hid),
        supabase.from("wb_moves").select("from_ep,to_ep,amount,date").eq("household_id", hid),
        supabase.from("wb_events").select("id,name,budget,active").eq("household_id", hid),
      ]);
      if (!st?.data) { cache[hid] = null; } else cache[hid] = { owner: hh?.created_by, s: summarize(st.data, tx ?? [], mv ?? [], ev ?? [], now.date) };
    }
    // deno-lint-ignore no-explicit-any
    const c = cache[hid] as any;
    if (!c) { failed++; continue; }
    const isOwner = c.owner === sub.user_id;
    const { out, names, customs, ev, resetTomorrow, frac } = c.s;
    const pools: string[] = isOwner ? ["aspen", "household", "extras", ...customs.map((x: any) => x.id)]
      : ["grace", "household", ...customs.filter((x: any) => x.shared).map((x: any) => x.id)];
    const label = (p: string) => (p === (isOwner ? "aspen" : "grace") ? "My Money" : names[p]);
    let title: string, body: string;
    if (resetTomorrow) {
      title = "Friday reload tomorrow";
      body = pools.map((p) => `${label(p)}: add ${money(out[p].nextBudget)} · ${money(out[p].left)} left → cushion`).join("\n");
    } else {
      title = `${overall(out, pools, frac)} Tomorrow’s starting balance`;
      body = pools.map((p) => `${label(p)}: ${money(out[p].left)}${out[p].left < 0 ? " (over)" : ""}`).join("\n");
    }
    const mine = out[isOwner ? "aspen" : "grace"];
    if (mine.cushion > 0) body += `\nSaved up: ${money(mine.cushion)}`;
    for (const e of ev) body += `\n${e.name}: ${money(e.left)} left`;
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
  return Response.json({ ok: true, eastern: now, sent, skipped, removed, failed, force });
});
