// Auto ads runner, end to end in ADS_SANDBOX mode (a simulated ad platform; everything else is real):
// connect → AI plan → paused launch → attributed sale → go live → simulated days → optimizer moves money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:8787';
const run = Date.now().toString(36);
const s = {};
const req = async (method, path, { token, body } = {}) => {
  const r = await fetch(API + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, location: r.headers.get('location'), ...(ct.includes('json') ? await r.json() : {}) };
};
const paid = async (orderId) => {
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', metadata: { order_id: orderId } } } });
  const t = Math.floor(Date.now() / 1000);
  await fetch(API + '/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${createHmac('sha256', 'whsec_karta_local_test').update(`${t}.${payload}`).digest('hex')}` }, body: payload });
};
const wait = async (fn, ms, what) => { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 2000)); } };

test('setup: producer with a live beat that has generated videos, and a buyer', { timeout: 300_000 }, async () => {
  const p = await req('POST', '/auth/signup', { body: { email: `ads${run}@k.test`, password: 'ads-12345', name: 'Ads Producer', handle: `ads${run}`, role: 'producer' } });
  s.P = p.data.token;
  const b = await req('POST', '/auth/signup', { body: { email: `fan${run}@k.test`, password: 'fan-12345', name: 'Ad Buyer', handle: `fan${run}`, role: 'buyer' } });
  s.B = b.data.token;
  await req('POST', '/dev/payouts-ready', { token: s.P });
  const beat = (await req('POST', '/studio/beats', { token: s.P, body: { title: 'Ad Riddim', bpm: 100, key: 'Am', genre: 'Dancehall', tags: ['one drop'] } })).data;
  s.beat = beat.id;
  const { readFileSync } = await import('node:fs');
  const D = '/tmp/claude-0/-home-claude/e6ba14b9-92fd-5409-b273-24d3d09ec34f/scratchpad/seed';
  for (const [kind, f, type] of [['preview', 'kingston.mp3', 'audio/mpeg'], ['mp3', 'kingston.mp3', 'audio/mpeg'], ['wav', 'kingston.wav', 'audio/wav']]) {
    const r = await fetch(`${API}/studio/beats/${s.beat}/files/${kind}`, { method: 'PUT', headers: { Authorization: `Bearer ${s.P}`, 'Content-Type': type }, body: readFileSync(`${D}/${f}`) });
    assert.equal(r.status, 200);
  }
  assert.equal((await req('POST', `/studio/beats/${s.beat}/publish`, { token: s.P, body: {} })).data.status, 'live');
  const pre = await req('POST', '/studio/ads/preview', { token: s.P, body: { beatId: s.beat, platforms: ['meta', 'tiktok', 'google'], dailyCap: 9000, days: 7 } });
  assert.ok(pre.data.warnings.some((w) => /9:16 video/.test(w)), 'no videos yet → warned');
  // real art job through the render server → cover, YouTube visualizer, 9:16 short
  assert.equal((await req('POST', `/studio/beats/${s.beat}/art`, { token: s.P, body: {} })).status, 200);
  await wait(async () => (await req('GET', `/studio/beats/${s.beat}/art`, { token: s.P })).data.job?.status === 'done', 280_000, 'art job');
});

test('connect Meta, TikTok and Google Ads (sandbox OAuth round trip)', async () => {
  for (const p of ['meta', 'tiktok', 'google']) {
    const c = await req('POST', `/studio/ads/connect/${p}`, { token: s.P });
    assert.equal(c.status, 200, JSON.stringify(c));
    const cb = new URL(c.data.url);
    assert.equal(cb.pathname, `/ads/callback/${p}`);
    const r = await req('GET', cb.pathname + cb.search);
    assert.equal(r.status, 302);
    assert.match(r.location, new RegExp(`/studio/ads\\?connected=${p}`));
  }
  const replay = await req('GET', `/ads/callback/meta?code=sandbox&state=st_fake`);
  assert.match(replay.location, /error=/, 'an unknown state is refused');
  const o = await req('GET', '/studio/ads', { token: s.P });
  assert.ok(o.data.connections.every((c) => c.connected && c.sandbox));
  assert.equal((await req('GET', '/studio/ads', { token: s.B })).status, 403, 'buyers can’t run ads');
});

test('the AI plan: Caribbean markets for dancehall, copy from the beat, a split that adds up', async () => {
  const pre = await req('POST', '/studio/ads/preview', { token: s.P, body: { beatId: s.beat, platforms: ['meta', 'tiktok', 'google'], dailyCap: 9000, days: 7 } });
  assert.equal(pre.status, 200, JSON.stringify(pre));
  assert.deepEqual(pre.data.warnings, []);
  assert.deepEqual(pre.data.arms[0].countries, ['JM', 'US', 'GB', 'CA', 'TT']);
  assert.equal(pre.data.arms.reduce((n, a) => n + a.dailyBudget, 0), 9000);
  assert.match(pre.data.copy.primary, /Ad Riddim.*100 BPM in Am/);
  const bad = await req('POST', '/studio/ads/preview', { token: s.P, body: { beatId: s.beat, platforms: ['meta'], dailyCap: 100, days: 7 } });
  assert.match(bad.error, /between \$5/);
});

test('launch creates paused campaigns on every platform', async () => {
  const l = await req('POST', '/studio/ads/campaigns', { token: s.P, body: { beatId: s.beat, platforms: ['meta', 'tiktok', 'google'], dailyCap: 9000, totalCap: 9000 * 7, days: 7, copy: { headline: 'Ad Riddim · one drop' } } });
  assert.equal(l.status, 200, JSON.stringify(l));
  s.c = l.data;
  assert.equal(l.data.status, 'ready');
  assert.equal(l.data.arms.length, 3);
  assert.ok(l.data.arms.every((a) => a.launched && !a.active && !a.error));
  assert.equal(l.data.copy.headline, 'Ad Riddim · one drop');
  assert.ok(l.data.arms.find((a) => a.platform === 'tiktok').dailyBudget >= 2000, 'TikTok raised to its $20 minimum');
});

test('a purchase from an ad click is attributed to that platform', async () => {
  const tiktokArm = s.c.arms.find((a) => a.platform === 'tiktok').id;
  const o = await req('POST', '/dev/checkout', { token: s.B, body: { beatId: s.beat, license: 'lease', attribution: { arm: tiktokArm, clickId: 'ttclid-123' } } });
  await paid(o.data.orderId);
  const d = await req('GET', `/studio/ads/campaigns/${s.c.id}`, { token: s.P });
  assert.equal(d.data.arms.find((a) => a.platform === 'tiktok').sales, 1);
  assert.ok(d.data.log.some((l) => /TikTok: a lease sold from an ad click/.test(l.text)));
  const forged = await req('POST', '/dev/checkout', { token: s.B, body: { beatId: s.beat, license: 'premium', attribution: { arm: 'arm_not_real' } } });
  await paid(forged.data.orderId);
  const d2 = await req('GET', `/studio/ads/campaigns/${s.c.id}`, { token: s.P });
  assert.equal(d2.data.sales, 1, 'made-up arm ids are ignored');
});

test('live: a week of simulated traffic; the optimizer shifts budget to what sells and respects the caps', async () => {
  const live = await req('POST', `/studio/ads/campaigns/${s.c.id}/live`, { token: s.P, body: { live: true } });
  assert.equal(live.data.status, 'active');
  assert.ok(live.data.arms.every((a) => a.active));
  let d;
  for (let day = 0; day < 6; day++) {
    await req('POST', `/dev/ads/simulate/${s.c.id}`, { token: s.P, body: { hours: 24, seed: day + 3 } });
    d = (await req('POST', `/studio/ads/campaigns/${s.c.id}/run`, { token: s.P })).data;
    const today = d.arms.filter((a) => a.active).reduce((n, a) => n + a.dailyBudget, 0);
    assert.ok(today <= 9000, `day ${day}: $${today / 100} over the $90 cap`);
  }
  const by = Object.fromEntries(d.arms.map((a) => [a.platform, a]));
  assert.ok(d.spend <= 9000 * 7, 'never over the total');
  assert.ok(by.tiktok.dailyBudget > by.google.dailyBudget || !by.google.active, `budgets: ${JSON.stringify(d.arms.map((a) => [a.platform, a.dailyBudget, a.active, a.sales]))}`);
  assert.ok(d.sales > 1, 'simulated ad clicks turned into attributed sales');
  assert.ok(d.log.some((l) => /Raised|Lowered|Paused/.test(l.text)), 'budget moves are explained in the log');
  assert.match(d.summary, /spent/);
  const sales = (await req('GET', '/studio/sales', { token: s.P })).data;
  assert.ok(sales.totals.count >= d.sales);
});

test('pause stops every platform', async () => {
  const p = await req('POST', `/studio/ads/campaigns/${s.c.id}/live`, { token: s.P, body: { live: false } });
  assert.equal(p.data.status, 'paused');
  assert.ok(p.data.arms.every((a) => !a.active));
  assert.equal((await req('DELETE', '/studio/ads/connect/meta', { token: s.P })).status, 200, 'can disconnect once nothing is live');
});
