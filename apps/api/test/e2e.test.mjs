// End-to-end against `npm run dev` (wrangler dev --local). Uses the dev checkout route plus a
// Stripe-signed webhook built with the local STRIPE_WEBHOOK_SECRET from .dev.vars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:8787';
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_karta_local_test';
const run = Date.now().toString(36);

async function req(method, path, { token, body, raw, type } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
}

async function webhookPaid(orderId) {
  const payload = JSON.stringify({ id: 'evt_' + run, type: 'checkout.session.completed', data: { object: { id: 'cs_test', payment_status: 'paid', client_reference_id: orderId, metadata: { order_id: orderId } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
  const r = await fetch(API + '/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}`, 'Content-Type': 'application/json' }, body: payload });
  return r.json();
}

const s = {};

test('producer and buyer sign up with roles and handles', async () => {
  const p = await req('POST', '/auth/signup', { body: { email: `nine${run}@example.com`, password: 'riddim-1234', name: 'Nine Mile Sound', handle: `ninemile${run}`, role: 'producer' } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.data.me.role, 'producer');
  s.prod = p.data.data.token; s.prodHandle = `ninemile${run}`;
  const b = await req('POST', '/auth/signup', { body: { email: `artist${run}@example.com`, password: 'verse-1234', name: 'Kemar B', handle: `kemar${run}`, role: 'buyer' } });
  assert.equal(b.status, 200);
  s.buyer = b.data.data.token; s.buyerHandle = `kemar${run}`;
  const dup = await req('POST', '/auth/signup', { body: { email: `x${run}@example.com`, password: 'abcdefgh', name: 'X', handle: `ninemile${run}` } });
  assert.equal(dup.status, 409);
  const bad = await req('POST', '/auth/login', { body: { email: `nine${run}@example.com`, password: 'wrong-pass' } });
  assert.equal(bad.status, 401);
});

test('profile settings save: bio, links, store prices, privacy', async () => {
  const r = await req('PATCH', '/me', { token: s.prod, body: {
    bio: 'Dancehall and drill from Spanish Town.', location: 'Spanish Town, Jamaica', genres: ['Dancehall', 'Drill'],
    links: { instagram: '@ninemile', youtube: 'Nine Mile Sound', junk: 'ignored' },
    settings: { store: { prices: { lease: 3500, exclusive: 90000 }, offered: { trackout: false } }, notifications: { likes: true } },
  } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = r.data.data;
  assert.equal(me.settings.store.prices.lease, 3500);
  assert.equal(me.settings.store.offered.trackout, false);
  assert.equal(me.settings.notifications.likes, true);
  assert.deepEqual(Object.keys(me.links).sort(), ['instagram', 'youtube']);
  const buyerOnly = await req('POST', '/studio/beats', { token: s.buyer, body: { title: 'nope' } });
  assert.equal(buyerOnly.status, 403);
});

test('producer creates, uploads and publishes a beat; it auto-posts to the feed', async () => {
  const c = await req('POST', '/studio/beats', { token: s.prod, body: { title: 'Spanish Town Dusk', bpm: 96, key: 'F#m', genre: 'Dancehall', tags: ['one drop', 'dark'] } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  s.beat = c.data.data.id;
  const early = await req('POST', `/studio/beats/${s.beat}/publish`, { token: s.prod, body: {} });
  assert.equal(early.status, 400, 'cannot publish without audio');
  for (const [kind, type] of [['preview', 'audio/mpeg'], ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['cover', 'image/jpeg']]) {
    const u = await req('PUT', `/studio/beats/${s.beat}/files/${kind}`, { token: s.prod, raw: new TextEncoder().encode(`${kind}-bytes`), type });
    assert.equal(u.status, 200, `${kind}: ${JSON.stringify(u.data)}`);
  }
  const pub = await req('POST', `/studio/beats/${s.beat}/publish`, { token: s.prod, body: { caption: 'New one drop out now' } });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.data.status, 'live');
  const feed = await req('GET', '/feed');
  const post = feed.data.data.posts.find((p) => p.beat?.id === s.beat);
  assert.ok(post, 'beat drop is in the feed');
  assert.equal(post.caption, 'New one drop out now');
  s.post = post.id;
  const prev = await req('GET', `/media/beats/${s.beat}/preview`);
  assert.equal(prev.status, 200);
  assert.equal(new TextDecoder().decode(prev.data), 'preview-bytes');
});

test('store shows the beat with the producer’s prices and offered licenses only', async () => {
  const st = await req('GET', `/store?q=spanish&producer=${s.prodHandle}`);
  const b = st.data.data.beats.find((x) => x.id === s.beat);
  assert.ok(b);
  assert.deepEqual(b.offers.map((o) => o.id), ['lease', 'premium', 'exclusive']);
  assert.equal(b.offers.find((o) => o.id === 'lease').price, 3500);
  assert.equal(b.from, 3500);
});

test('buyer follows, likes, reposts, favorites; following feed works', async () => {
  assert.equal((await req('POST', `/u/${s.prodHandle}/follow`, { token: s.buyer, body: {} })).status, 200);
  const like = await req('POST', `/posts/${s.post}/like`, { token: s.buyer, body: {} });
  assert.equal(like.data.data.likes, 1);
  assert.equal((await req('POST', `/posts/${s.post}/repost`, { token: s.buyer, body: {} })).status, 200);
  assert.equal((await req('POST', `/beats/${s.beat}/favorite`, { token: s.buyer, body: {} })).data.data.favorited, true);
  const ff = await req('GET', '/feed?scope=following', { token: s.buyer });
  assert.ok(ff.data.data.posts.some((p) => p.beat?.id === s.beat));
  const prof = await req('GET', `/u/${s.prodHandle}`, { token: s.buyer });
  assert.equal(prof.data.data.followers, 1);
  assert.equal(prof.data.data.followedByMe, true);
  assert.equal(prof.data.data.stats.beats, 1);
});

test('checkout is refused until the producer sets up payouts', async () => {
  const r = await req('POST', '/checkout', { token: s.buyer, body: { beatId: s.beat, license: 'lease' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /payouts/);
});

test('lease purchase: signed webhook grants a license with MP3 only', async () => {
  await req('POST', '/dev/payouts-ready', { token: s.prod });
  const o = await req('POST', '/dev/checkout', { token: s.buyer, body: { beatId: s.beat, license: 'lease' } });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const forged = await fetch(API + '/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` }, body: '{}' });
  assert.equal(forged.status, 400, 'forged webhook is rejected');
  const w = await webhookPaid(o.data.data.orderId);
  assert.equal(w.data.ok, true);
  const again = await webhookPaid(o.data.data.orderId);
  assert.equal(again.data.duplicate, true, 'webhook is idempotent');
  const lib = await req('GET', '/library', { token: s.buyer });
  const p = lib.data.data.purchases[0];
  assert.equal(p.license, 'lease');
  assert.deepEqual(p.files.map((f) => f.kind), ['mp3']);
  const mp3 = await req('GET', p.files[0].url);
  assert.equal(new TextDecoder().decode(mp3.data), 'mp3-bytes');
  const wav = await req('GET', p.files[0].url.replace(/mp3$/, 'wav'));
  assert.equal(wav.status, 403, 'lease does not include WAV');
  const lic = await req('GET', p.agreement);
  assert.match(new TextDecoder().decode(lic.data), /BASIC LEASE[\s\S]*Spanish Town Dusk[\s\S]*Kemar B/);
  const sales = await req('GET', '/studio/sales', { token: s.prod });
  assert.equal(sales.data.data.totals.gross, 3500);
  assert.equal(sales.data.data.totals.fees, 350);
});

test('exclusive purchase takes the beat off the store, the feed and favorites', async () => {
  const o = await req('POST', '/dev/checkout', { token: s.buyer, body: { beatId: s.beat, license: 'exclusive' } });
  await webhookPaid(o.data.data.orderId);
  const beat = await req('GET', `/beats/${s.beat}`, { token: s.buyer });
  assert.equal(beat.data.data.status, 'sold');
  const st = await req('GET', `/store?producer=${s.prodHandle}`);
  assert.equal(st.data.data.beats.length, 0);
  const feed = await req('GET', '/feed');
  assert.ok(!feed.data.data.posts.some((p) => p.beat?.id === s.beat || p.targetId === s.post));
  const lib = await req('GET', '/library', { token: s.buyer });
  const ex = lib.data.data.purchases.find((p) => p.license === 'exclusive');
  assert.deepEqual(ex.files.map((f) => f.kind), ['mp3', 'wav']);
  assert.equal(lib.data.data.favorites.length, 0);
  const another = await req('POST', '/auth/signup', { body: { email: `late${run}@example.com`, password: 'late-12345', name: 'Late', handle: `late${run}` } });
  const late = await req('POST', '/dev/checkout', { token: another.data.data.token, body: { beatId: s.beat, license: 'lease' } });
  assert.equal(late.status, 404, 'sold beat cannot be bought again');
  const edit = await req('PATCH', `/studio/beats/${s.beat}`, { token: s.prod, body: { title: 'x' } });
  assert.equal(edit.status, 400);
});

test('buyer profile hides purchases unless they choose to show them', async () => {
  const hidden = await req('GET', `/u/${s.buyerHandle}`);
  assert.equal(hidden.data.data.collection, undefined);
  await req('PATCH', '/me', { token: s.buyer, body: { settings: { privacy: { showPurchases: true } } } });
  const shown = await req('GET', `/u/${s.buyerHandle}`);
  assert.equal(shown.data.data.collection.length, 1);
  assert.equal(shown.data.data.stats.purchases, 2);
});

test('art job needs the renderer; internal routes need the render secret', async () => {
  const a = await req('POST', `/studio/beats/${s.beat}/art`, { token: s.prod, body: {} });
  assert.ok([400, 503].includes(a.status), JSON.stringify(a.data));
  const i = await req('POST', '/internal/jobs/j_x', { body: {} });
  assert.equal(i.status, 401);
});
