// functions/ads.ts | Karta's auto ads runner, inside KartaDB.
//
//  • Producers connect Meta, TikTok and Google Ads with OAuth. Tokens are encrypted (AES-GCM, ADS_TOKEN_KEY).
//  • "Promote a beat" plans one campaign per platform (lib/ads/planner), launches them PAUSED, and goes
//    live only when the producer says so.
//  • Every 6 hours an alarm reads each platform's spend and clicks, counts the license sales Karta saw
//    from that platform's clicks, runs the optimizer (lib/ads/optimizer) and applies its budget moves.
//  • Sales from ad clicks are reported back (Conversions API / Events API / offline conversions).
//  • ADS_SANDBOX=1 swaps in a simulated platform so the loop can be tried without spending money.

import { ApiError, text, uid } from './lib/util';
import { meta, tiktok, google, planCampaign, aiCopy, optimize, type AdPlatform, type AdAccount, type PlatformId, type Tokens, type Launched, type BeatForAds, type LaunchPlan, type Metrics } from './lib/ads';

export interface AdsEnv {
  META_APP_ID?: string; META_APP_SECRET?: string;
  TIKTOK_APP_ID?: string; TIKTOK_SECRET?: string;
  GOOGLE_ADS_CLIENT_ID?: string; GOOGLE_ADS_CLIENT_SECRET?: string; GOOGLE_ADS_DEVELOPER_TOKEN?: string; GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  ADS_TOKEN_KEY?: string; ADS_SANDBOX?: string; ANTHROPIC_API_KEY?: string; ADS_COPY_MODEL?: string;
  PUBLIC_API_URL?: string; WEB_URL?: string;
}

export const ADS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ad_connections (user_id TEXT NOT NULL, platform TEXT NOT NULL, tokens TEXT NOT NULL, accounts TEXT NOT NULL DEFAULT '[]', account TEXT NOT NULL DEFAULT '{}', connected_at INTEGER NOT NULL, PRIMARY KEY (user_id, platform));
CREATE TABLE IF NOT EXISTS ad_states (state TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ad_campaigns (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, beat_id TEXT NOT NULL, status TEXT NOT NULL, daily_cap INTEGER NOT NULL, total_cap INTEGER NOT NULL, days INTEGER NOT NULL, starts_at INTEGER NOT NULL DEFAULT 0, ends_at INTEGER NOT NULL DEFAULT 0, copy TEXT NOT NULL DEFAULT '{}', countries TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', last_run INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ad_arms (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, platform TEXT NOT NULL, launched TEXT NOT NULL DEFAULT '{}', plan TEXT NOT NULL DEFAULT '{}', daily_budget INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, spend INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, p_best REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS ad_log (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ad_sandbox (ref TEXT PRIMARY KEY, budget INTEGER NOT NULL, active INTEGER NOT NULL, spend INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0);
`;

export const RUN_EVERY = 6 * 3_600_000;
const PLATFORMS: PlatformId[] = ['meta', 'tiktok', 'google'];
type Sql = SqlStorage;
type Row = Record<string, SqlStorageValue>;
const one = (sql: Sql, q: string, ...p: SqlStorageValue[]) => sql.exec(q, ...p).toArray()[0] as Row | undefined;
const all = (sql: Sql, q: string, ...p: SqlStorageValue[]) => sql.exec(q, ...p).toArray() as Row[];

/* ---------------- platforms ---------------- */
export function platformFor(env: AdsEnv, p: PlatformId, sql: Sql): AdPlatform {
  if (env.ADS_SANDBOX === '1') return sandbox(p, sql);
  if (p === 'meta') { if (!env.META_APP_ID || !env.META_APP_SECRET) throw new ApiError(503, 'Meta ads aren’t set up yet. Add META_APP_ID and META_APP_SECRET.'); return meta({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET }); }
  if (p === 'tiktok') { if (!env.TIKTOK_APP_ID || !env.TIKTOK_SECRET) throw new ApiError(503, 'TikTok ads aren’t set up yet. Add TIKTOK_APP_ID and TIKTOK_SECRET.'); return tiktok({ appId: env.TIKTOK_APP_ID, secret: env.TIKTOK_SECRET }); }
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET || !env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new ApiError(503, 'Google Ads isn’t set up yet. Add GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_DEVELOPER_TOKEN.');
  return google({ clientId: env.GOOGLE_ADS_CLIENT_ID, clientSecret: env.GOOGLE_ADS_CLIENT_SECRET, developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN, loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID });
}

/** Simulated ad platform for sandbox mode: real flow, fake money. */
function sandbox(p: PlatformId, sql: Sql): AdPlatform {
  const min = { meta: 100, tiktok: 2000, google: 500 }[p];
  return {
    id: p, minDaily: min,
    authUrl: (state, redirect) => `${redirect}?code=sandbox&state=${encodeURIComponent(state)}`,
    exchange: async () => ({ accessToken: `sandbox-${p}` }),
    accounts: async (): Promise<AdAccount[]> => [{ id: `sandbox_${p}`, name: `${{ meta: 'Meta', tiktok: 'TikTok', google: 'Google Ads' }[p]} sandbox account`, currency: 'USD', extra: p === 'meta' ? { pageId: 'sandbox_page' } : ({} as Record<string, string>) }],
    async launch(_t, _a, plan) {
      const ref = uid(`sb_${p}_`);
      sql.exec('INSERT INTO ad_sandbox (ref, budget, active) VALUES (?, ?, 0)', ref, Math.max(min, plan.dailyBudget));
      return { platform: p, campaignId: ref, groupId: ref, adIds: [ref], budgetRef: ref, extra: { sandbox: '1' } };
    },
    async metrics(_t, _a, l): Promise<Metrics> {
      const r = one(sql, 'SELECT * FROM ad_sandbox WHERE ref = ?', l.groupId);
      return { spend: Number(r?.spend ?? 0), clicks: Number(r?.clicks ?? 0), impressions: Number(r?.impressions ?? 0), platformConversions: 0 };
    },
    async setDailyBudget(_t, _a, l, cents) { sql.exec('UPDATE ad_sandbox SET budget = ? WHERE ref = ?', Math.max(min, cents), l.groupId); },
    async setActive(_t, _a, l, active) { sql.exec('UPDATE ad_sandbox SET active = ? WHERE ref = ?', active ? 1 : 0, l.groupId); },
    async sendConversion() { /* nothing to report in sandbox */ },
  };
}

/* ---------------- token encryption ---------------- */
async function key(env: AdsEnv): Promise<CryptoKey | null> {
  if (!env.ADS_TOKEN_KEY) return null;
  const raw = Uint8Array.from(atob(env.ADS_TOKEN_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env: AdsEnv, t: Tokens): Promise<string> {
  const k = await key(env);
  if (!k) {
    if (env.ADS_SANDBOX === '1') return 'plain:' + JSON.stringify(t);
    throw new ApiError(503, 'Ad connections need ADS_TOKEN_KEY (a base64 AES key) to store tokens safely.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(t))));
  return 'v1:' + btoa(String.fromCharCode(...iv)) + ':' + btoa(String.fromCharCode(...ct));
}
async function open(env: AdsEnv, s: string): Promise<Tokens> {
  if (s.startsWith('plain:')) return JSON.parse(s.slice(6));
  const k = await key(env);
  if (!k) throw new ApiError(503, 'ADS_TOKEN_KEY is missing, so saved ad connections can’t be read.');
  const [, iv, ct] = s.split(':');
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)) }, k, Uint8Array.from(atob(ct), (c) => c.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(dec));
}

/* ---------------- connections ---------------- */
const asPlatform = (v: unknown): PlatformId => { const p = text(v, 10) as PlatformId; if (!PLATFORMS.includes(p)) throw new ApiError(404, 'Unknown ad platform'); return p; };
const redirectFor = (env: AdsEnv, origin: string, p: PlatformId) => `${(env.PUBLIC_API_URL ?? origin).replace(/\/$/, '')}/ads/callback/${p}`;

export function connectUrl(env: AdsEnv, sql: Sql, userId: string, platform: unknown, origin: string) {
  const p = asPlatform(platform);
  const state = uid('st_') + uid();
  sql.exec('INSERT INTO ad_states (state, user_id, platform, expires_at) VALUES (?, ?, ?, ?)', state, userId, p, Date.now() + 15 * 60_000);
  return { url: platformFor(env, p, sql).authUrl(state, redirectFor(env, origin, p)) };
}

export async function finishConnect(env: AdsEnv, sql: Sql, platform: unknown, code: string, state: string, origin: string) {
  const p = asPlatform(platform);
  const s = one(sql, 'SELECT * FROM ad_states WHERE state = ? AND platform = ?', state, p);
  sql.exec('DELETE FROM ad_states WHERE state = ? OR expires_at < ?', state, Date.now());
  if (!s || Number(s.expires_at) < Date.now()) throw new ApiError(400, 'That sign-in link expired. Start the connection again.');
  const plat = platformFor(env, p, sql);
  const tokens = await plat.exchange(code, redirectFor(env, origin, p));
  const accounts = await plat.accounts(tokens);
  sql.exec('INSERT OR REPLACE INTO ad_connections (user_id, platform, tokens, accounts, account, connected_at) VALUES (?, ?, ?, ?, ?, ?)',
    String(s.user_id), p, await seal(env, tokens), JSON.stringify(accounts), JSON.stringify(accounts[0] ?? {}), Date.now());
  return { platform: p, accounts: accounts.length };
}

export function connections(env: AdsEnv, sql: Sql, userId: string) {
  return PLATFORMS.map((p) => {
    const c = one(sql, 'SELECT * FROM ad_connections WHERE user_id = ? AND platform = ?', userId, p);
    let available = true, setup = '';
    try { platformFor(env, p, sql); } catch (e) { available = false; setup = (e as Error).message; }
    return {
      platform: p, available, setup, sandbox: env.ADS_SANDBOX === '1',
      connected: !!c, account: c ? JSON.parse(String(c.account)) as AdAccount : null,
      accounts: c ? (JSON.parse(String(c.accounts)) as AdAccount[]).map((a) => ({ id: a.id, name: a.name, currency: a.currency })) : [],
    };
  });
}

/** Pick the ad account and the tracking ids (Meta Page + Pixel, TikTok Pixel, Google conversion action). */
export function setAccount(sql: Sql, userId: string, platform: unknown, a: Record<string, unknown>) {
  const p = asPlatform(platform);
  const c = one(sql, 'SELECT * FROM ad_connections WHERE user_id = ? AND platform = ?', userId, p);
  if (!c) throw new ApiError(400, 'Connect that platform first.');
  const accounts = JSON.parse(String(c.accounts)) as AdAccount[];
  const cur = JSON.parse(String(c.account)) as AdAccount;
  const chosen = accounts.find((x) => x.id === text(a.accountId, 60)) ?? cur;
  const extra: Record<string, string> = { ...(cur.id === chosen.id ? cur.extra : chosen.extra) };
  for (const k of ['pageId', 'pixelId', 'pixelCode', 'conversionAction', 'identityId']) if (typeof a[k] === 'string') extra[k] = text(a[k], 120);
  sql.exec('UPDATE ad_connections SET account = ? WHERE user_id = ? AND platform = ?', JSON.stringify({ ...chosen, extra }), userId, p);
  return { ok: true };
}

export function disconnect(sql: Sql, userId: string, platform: unknown) {
  const p = asPlatform(platform);
  if (one(sql, "SELECT 1 FROM ad_arms a JOIN ad_campaigns c ON c.id = a.campaign_id WHERE c.user_id = ? AND a.platform = ? AND c.status = 'active' AND a.active = 1", userId, p)) {
    throw new ApiError(400, 'Pause the live campaigns on this platform before disconnecting it.');
  }
  sql.exec('DELETE FROM ad_connections WHERE user_id = ? AND platform = ?', userId, p);
  return { ok: true };
}

async function conn(env: AdsEnv, sql: Sql, userId: string, p: PlatformId) {
  const c = one(sql, 'SELECT * FROM ad_connections WHERE user_id = ? AND platform = ?', userId, p);
  if (!c) throw new ApiError(400, `Connect ${p === 'google' ? 'Google Ads' : p === 'meta' ? 'Meta' : 'TikTok'} first.`);
  const plat = platformFor(env, p, sql);
  let tokens = await open(env, String(c.tokens));
  if (plat.refresh && tokens.expiresAt && tokens.expiresAt < Date.now() + 120_000) {
    tokens = await plat.refresh(tokens);
    sql.exec('UPDATE ad_connections SET tokens = ? WHERE user_id = ? AND platform = ?', await seal(env, tokens), userId, p);
  }
  return { plat, tokens, account: JSON.parse(String(c.account)) as AdAccount };
}

/* ---------------- planning & launching ---------------- */
export interface BeatInfo { beat: BeatForAds; ready: { tall: boolean; wide: boolean } }

export function settingsFrom(a: Record<string, unknown>) {
  const platforms = (Array.isArray(a.platforms) ? a.platforms : []).map((x) => text(x, 10)).filter((x): x is PlatformId => PLATFORMS.includes(x as PlatformId));
  const dailyCap = Math.round(Number(a.dailyCap));
  const days = Math.round(Number(a.days));
  const totalCap = Math.round(Number(a.totalCap ?? dailyCap * days));
  if (!platforms.length) throw new ApiError(400, 'Pick at least one platform.');
  if (!(dailyCap >= 500) || dailyCap > 1_000_000) throw new ApiError(400, 'Set a daily budget between $5 and $10,000.');
  if (!(days >= 1 && days <= 90)) throw new ApiError(400, 'Run it for 1 to 90 days.');
  if (!(totalCap >= dailyCap) || totalCap > dailyCap * days) throw new ApiError(400, 'The total budget has to be at least one day’s budget and at most daily × days.');
  const countries = (Array.isArray(a.countries) ? a.countries : []).map((c) => text(c, 2).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 12);
  return { platforms, dailyCap, totalCap, days, countries: countries.length ? countries : undefined, ageMin: Number(a.ageMin) >= 18 ? Math.min(65, Math.round(Number(a.ageMin))) : 18 };
}

export async function preview(env: AdsEnv, sql: Sql, userId: string, info: BeatInfo, a: Record<string, unknown>) {
  const s = settingsFrom(a);
  const copy = await aiCopy(info.beat, { apiKey: env.ANTHROPIC_API_KEY, model: env.ADS_COPY_MODEL });
  const planned = planCampaign(info.beat, s, copy, (p) => `preview_${p}`);
  const conns = connections(env, sql, userId);
  const warnings: string[] = [];
  if (!info.ready.tall) warnings.push('This beat has no 9:16 video yet, so TikTok and Meta are skipped. Generate artwork in the beat editor first.');
  if (!info.ready.wide && s.platforms.includes('google')) warnings.push('This beat has no YouTube video yet, so Google is skipped. Generate artwork first.');
  for (const p of s.platforms) if (!conns.find((c) => c.platform === p)?.connected) warnings.push(`${p === 'google' ? 'Google Ads' : p === 'meta' ? 'Meta' : 'TikTok'} isn’t connected.`);
  for (const arm of planned) {
    const min = platformFor(env, arm.platform, sql).minDaily;
    if (arm.plan.dailyBudget < min) warnings.push(`${arm.platform === 'tiktok' ? 'TikTok' : arm.platform === 'meta' ? 'Meta' : 'Google'} needs at least $${(min / 100).toFixed(0)}/day; its share will be raised to that and the others trimmed.`);
  }
  return { copy, aiWritten: !!env.ANTHROPIC_API_KEY, arms: planned.map((p) => ({ platform: p.platform, dailyBudget: p.plan.dailyBudget, countries: p.plan.countries, reason: p.reason })), warnings, settings: s };
}

export async function launch(env: AdsEnv, sql: Sql, userId: string, info: BeatInfo, a: Record<string, unknown>) {
  const s = settingsFrom(a);
  const base = await aiCopy(info.beat, { apiKey: env.ANTHROPIC_API_KEY, model: env.ADS_COPY_MODEL });
  const edits = (a.copy && typeof a.copy === 'object' ? a.copy : {}) as Record<string, unknown>;
  const copy: LaunchPlan['copy'] = {
    primary: text(edits.primary, 125) || base.primary, headline: text(edits.headline, 40) || base.headline,
    longHeadline: text(edits.longHeadline, 90) || base.longHeadline, description: text(edits.description, 90) || base.description, cta: base.cta,
  };
  const id = uid('ac_');
  const armIds = new Map<PlatformId, string>(s.platforms.map((p) => [p, uid('arm_')]));
  const planned = planCampaign(info.beat, s, copy, (p) => armIds.get(p)!);
  if (!planned.length) throw new ApiError(400, 'None of the picked platforms can run yet. Generate the beat’s videos first.');
  const now = Date.now();
  sql.exec("INSERT INTO ad_campaigns (id, user_id, beat_id, status, daily_cap, total_cap, days, copy, countries, created_at) VALUES (?, ?, ?, 'launching', ?, ?, ?, ?, ?, ?)",
    id, userId, info.beat.id, s.dailyCap, s.totalCap, s.days, JSON.stringify(copy), JSON.stringify(planned[0].plan.countries), now);
  const log = (t: string) => sql.exec('INSERT INTO ad_log (campaign_id, at, text) VALUES (?, ?, ?)', id, Date.now(), t);
  log(`Planned ${planned.length} platform${planned.length === 1 ? '' : 's'} for “${info.beat.title}”: $${(s.dailyCap / 100).toFixed(2)}/day, $${(s.totalCap / 100).toFixed(2)} total, ${s.days} days.`);
  let ok = 0;
  for (const arm of planned) {
    const armId = armIds.get(arm.platform)!;
    sql.exec('INSERT INTO ad_arms (id, campaign_id, platform, plan, daily_budget) VALUES (?, ?, ?, ?, ?)', armId, id, arm.platform, JSON.stringify(arm.plan), arm.plan.dailyBudget);
    try {
      const { plat, tokens, account } = await conn(env, sql, userId, arm.platform);
      const plan = { ...arm.plan, dailyBudget: Math.max(plat.minDaily, arm.plan.dailyBudget) };
      if (arm.platform === 'google' && !plan.creative.youtubeVideoId && plan.creative.wideVideoUrl && 'uploadToYouTube' in plat) {
        plan.creative.youtubeVideoId = await (plat as ReturnType<typeof google>).uploadToYouTube(tokens, plan.creative.wideVideoUrl, `${info.beat.title} | ${info.beat.genre} beat | prod. ${info.beat.producer}`, `${copy.primary}\n${info.beat.url}`);
        log(`Put the cinematic video on YouTube (unlisted) for the Google ad.`);
      }
      const l = await plat.launch(tokens, account, plan);
      sql.exec('UPDATE ad_arms SET launched = ?, daily_budget = ?, plan = ? WHERE id = ?', JSON.stringify(l), plan.dailyBudget, JSON.stringify(plan), armId);
      log(`${label(arm.platform)}: campaign created, paused. ${arm.reason}`);
      ok++;
    } catch (e) {
      sql.exec('UPDATE ad_arms SET error = ? WHERE id = ?', (e as Error).message.slice(0, 300), armId);
      log(`${label(arm.platform)}: couldn’t create the campaign. ${(e as Error).message}`);
    }
  }
  sql.exec('UPDATE ad_campaigns SET status = ? WHERE id = ?', ok ? 'ready' : 'failed', id);
  return detail(sql, userId, id);
}

const label = (p: PlatformId | string) => ({ meta: 'Meta', tiktok: 'TikTok', google: 'Google Ads' }[p as PlatformId] ?? p);

export async function setLive(env: AdsEnv, sql: Sql, userId: string, id: string, live: boolean) {
  const c = one(sql, 'SELECT * FROM ad_campaigns WHERE id = ? AND user_id = ?', id, userId);
  if (!c) throw new ApiError(404, 'Campaign not found.');
  if (live && !['ready', 'paused'].includes(String(c.status))) throw new ApiError(400, c.status === 'ended' ? 'This campaign has ended.' : 'This campaign can’t start yet.');
  const arms = all(sql, "SELECT * FROM ad_arms WHERE campaign_id = ? AND launched != '{}' AND error = ''", id);
  if (live && !arms.length) throw new ApiError(400, 'No platform launched successfully.');
  const log = (t: string) => sql.exec('INSERT INTO ad_log (campaign_id, at, text) VALUES (?, ?, ?)', id, Date.now(), t);
  for (const a of arms) {
    try {
      const { plat, tokens, account } = await conn(env, sql, userId, a.platform as PlatformId);
      await plat.setActive(tokens, account, JSON.parse(String(a.launched)) as Launched, live);
      sql.exec('UPDATE ad_arms SET active = ? WHERE id = ?', live ? 1 : 0, String(a.id));
    } catch (e) { log(`${label(String(a.platform))}: ${(e as Error).message}`); }
  }
  const now = Date.now();
  if (live) sql.exec("UPDATE ad_campaigns SET status = 'active', starts_at = CASE WHEN starts_at = 0 THEN ? ELSE starts_at END, ends_at = CASE WHEN ends_at = 0 THEN ? ELSE ends_at END WHERE id = ?", now, now + Number(c.days) * 86_400_000, id);
  else sql.exec("UPDATE ad_campaigns SET status = 'paused' WHERE id = ?", id);
  log(live ? 'Went live. The optimizer checks results every 6 hours.' : 'Paused by you.');
  return detail(sql, userId, id);
}

/* ---------------- the optimizer run ---------------- */
export async function runCampaign(env: AdsEnv, sql: Sql, id: string, avgOrder: number) {
  const c = one(sql, 'SELECT * FROM ad_campaigns WHERE id = ?', id);
  if (!c || c.status !== 'active') return;
  const userId = String(c.user_id);
  const log = (t: string) => sql.exec('INSERT INTO ad_log (campaign_id, at, text) VALUES (?, ?, ?)', id, Date.now(), t);
  const rows = all(sql, "SELECT * FROM ad_arms WHERE campaign_id = ? AND launched != '{}' AND error = ''", id);
  // 1) fresh numbers from each platform, and Karta's own sales per arm
  for (const a of rows) {
    try {
      const { plat, tokens, account } = await conn(env, sql, userId, a.platform as PlatformId);
      const m = await plat.metrics(tokens, account, JSON.parse(String(a.launched)));
      sql.exec('UPDATE ad_arms SET spend = ?, clicks = ?, impressions = ? WHERE id = ?', m.spend, m.clicks, m.impressions, String(a.id));
    } catch (e) { log(`${label(String(a.platform))}: couldn’t read results (${(e as Error).message}).`); }
  }
  const arms = all(sql, "SELECT * FROM ad_arms WHERE campaign_id = ? AND launched != '{}' AND error = ''", id).map((a) => {
    const s = one(sql, "SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) r FROM orders WHERE status = 'paid' AND json_extract(attribution, '$.arm') = ?", String(a.id));
    return {
      id: String(a.id), platform: a.platform as PlatformId, active: !!a.active, dailyBudget: Number(a.daily_budget), minDaily: platformFor(env, a.platform as PlatformId, sql).minDaily,
      spend: Number(a.spend), clicks: Number(a.clicks), impressions: Number(a.impressions), sales: Number(s?.n ?? 0), revenue: Number(s?.r ?? 0),
    };
  });
  const spent = arms.reduce((n, a) => n + a.spend, 0);
  const daysLeft = Math.max(1, Math.ceil((Number(c.ends_at) - Date.now()) / 86_400_000));
  const ended = Number(c.ends_at) && Date.now() >= Number(c.ends_at);
  const plan = optimize(arms, { dailyCap: Number(c.daily_cap), totalCap: Number(c.total_cap), totalSpent: spent, daysLeft, avgOrder, seed: Math.floor(Date.now() / RUN_EVERY) });
  // 2) apply
  for (const d of plan.decisions) {
    const a = rows.find((r) => r.id === d.armId)!;
    sql.exec('UPDATE ad_arms SET p_best = ? WHERE id = ?', d.pBest, d.armId);
    if (d.action === 'keep' && !(plan.stopAll || ended)) continue;
    try {
      const { plat, tokens, account } = await conn(env, sql, userId, a.platform as PlatformId);
      const l = JSON.parse(String(a.launched)) as Launched;
      if (d.action === 'pause' || plan.stopAll || ended) { if (a.active) await plat.setActive(tokens, account, l, false); sql.exec('UPDATE ad_arms SET active = 0 WHERE id = ?', d.armId); }
      else {
        if (d.to !== Number(a.daily_budget)) await plat.setDailyBudget(tokens, account, l, d.to);
        if (!a.active) await plat.setActive(tokens, account, l, true);
        sql.exec('UPDATE ad_arms SET daily_budget = ?, active = 1 WHERE id = ?', d.to, d.armId);
      }
      if (d.action !== 'keep') log(`${label(d.platform)}: ${d.reason}`);
    } catch (e) { log(`${label(d.platform)}: couldn’t apply the change (${(e as Error).message}).`); }
  }
  if (plan.stopAll || ended) {
    sql.exec("UPDATE ad_campaigns SET status = 'ended', summary = ?, last_run = ? WHERE id = ?", ended ? `Finished. ${plan.summary}` : plan.summary, Date.now(), id);
    log(ended ? 'The campaign reached its end date and was paused everywhere.' : plan.summary);
  } else {
    sql.exec('UPDATE ad_campaigns SET summary = ?, last_run = ? WHERE id = ?', plan.summary, Date.now(), id);
    log(plan.summary);
  }
}

/* ---------------- conversions ---------------- */
export async function reportSale(env: AdsEnv, sql: Sql, order: Row) {
  const attr = JSON.parse(String(order.attribution ?? '{}')) as { arm?: string; clickId?: string; ip?: string; ua?: string };
  if (!attr.arm) return;
  const a = one(sql, 'SELECT a.*, c.user_id, c.id cid FROM ad_arms a JOIN ad_campaigns c ON c.id = a.campaign_id WHERE a.id = ?', attr.arm);
  if (!a) return;
  sql.exec('INSERT INTO ad_log (campaign_id, at, text) VALUES (?, ?, ?)', String(a.cid), Date.now(), `${label(String(a.platform))}: a ${String(order.license)} sold from an ad click ($${(Number(order.amount_cents) / 100).toFixed(2)}).`);
  try {
    const { plat, tokens, account } = await conn(env, sql, String(a.user_id), a.platform as PlatformId);
    await plat.sendConversion?.(tokens, account, {
      email: String(order.buyer_email), clickId: attr.clickId, value: Number(order.amount_cents), currency: 'usd', at: Number(order.paid_at) || Date.now(),
      orderId: String(order.id), url: `${(env.WEB_URL ?? '').replace(/\/$/, '')}/beat/${order.beat_id}`, ip: attr.ip, userAgent: attr.ua,
    });
  } catch (e) { console.warn('[ads] conversion report failed', (e as Error).message); }
}

/* ---------------- reads ---------------- */
export function list(sql: Sql, userId: string) {
  return all(sql, 'SELECT c.*, b.title FROM ad_campaigns c LEFT JOIN beats b ON b.id = c.beat_id WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 50', userId).map((c) => {
    const t = one(sql, 'SELECT COALESCE(SUM(spend),0) s, COALESCE(SUM(clicks),0) k FROM ad_arms WHERE campaign_id = ?', String(c.id));
    const sales = one(sql, "SELECT COUNT(*) n, COALESCE(SUM(o.amount_cents),0) r FROM orders o JOIN ad_arms a ON a.id = json_extract(o.attribution, '$.arm') WHERE a.campaign_id = ? AND o.status = 'paid'", String(c.id));
    return { id: c.id, beatId: c.beat_id, title: c.title, status: c.status, dailyCap: c.daily_cap, totalCap: c.total_cap, days: c.days, spend: Number(t?.s ?? 0), clicks: Number(t?.k ?? 0), sales: Number(sales?.n ?? 0), revenue: Number(sales?.r ?? 0), createdAt: c.created_at, summary: c.summary };
  });
}

export function detail(sql: Sql, userId: string, id: string) {
  const c = list(sql, userId).find((x) => x.id === id);
  if (!c) throw new ApiError(404, 'Campaign not found.');
  const row = one(sql, 'SELECT * FROM ad_campaigns WHERE id = ?', id)!;
  const arms = all(sql, 'SELECT * FROM ad_arms WHERE campaign_id = ? ORDER BY platform', id).map((a) => {
    const s = one(sql, "SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) r FROM orders WHERE status = 'paid' AND json_extract(attribution, '$.arm') = ?", String(a.id));
    return { id: a.id, platform: a.platform, active: !!a.active, dailyBudget: a.daily_budget, spend: a.spend, clicks: a.clicks, impressions: a.impressions, sales: Number(s?.n ?? 0), revenue: Number(s?.r ?? 0), pBest: a.p_best, error: a.error, launched: a.launched !== '{}' };
  });
  const log = all(sql, 'SELECT at, text FROM ad_log WHERE campaign_id = ? ORDER BY id DESC LIMIT 80', id).map((l) => ({ at: l.at, text: l.text }));
  return { ...c, copy: JSON.parse(String(row.copy)), countries: JSON.parse(String(row.countries)), startsAt: row.starts_at, endsAt: row.ends_at, lastRun: row.last_run, arms, log };
}

/** Sandbox only: pretend `hours` pass on every live sandbox ad, with a fixed cost per click per platform. */
export function sandboxAdvance(sql: Sql, campaignId: string, hours: number): { arm: string; platform: string; clicks: number }[] {
  const cpc = { meta: 55, tiktok: 35, google: 90 } as Record<string, number>;
  return all(sql, 'SELECT a.id, a.platform, a.launched FROM ad_arms a WHERE a.campaign_id = ? AND a.active = 1', campaignId).map((a) => {
    const l = JSON.parse(String(a.launched)) as Launched;
    const sb = one(sql, 'SELECT * FROM ad_sandbox WHERE ref = ?', l.groupId);
    if (!sb || !sb.active) return { arm: String(a.id), platform: String(a.platform), clicks: 0 };
    const spend = Math.round((Number(sb.budget) * hours) / 24);
    const clicks = Math.floor(spend / cpc[String(a.platform)]);
    sql.exec('UPDATE ad_sandbox SET spend = spend + ?, clicks = clicks + ?, impressions = impressions + ? WHERE ref = ?', clicks * cpc[String(a.platform)], clicks, clicks * 60, l.groupId);
    return { arm: String(a.id), platform: String(a.platform), clicks };
  });
}
