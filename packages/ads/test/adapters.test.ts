import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meta, tiktok, google, planCampaign, templateCopy, type LaunchPlan } from '../src/index.js';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function recorder(reply: (c: Call, i: number) => unknown) {
  const calls: Call[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    const h = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any = init.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body.entries());
    else if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    const c = { url: String(url), method: init.method ?? 'GET', headers: h, body };
    calls.push(c);
    const out = reply(c, calls.length - 1);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { http, calls };
}

const beat = { id: 'b_1', title: 'Kingston Nights', producer: 'Nine Mile Sound', genre: 'Dancehall', bpm: 100, key: 'Am', tags: ['one drop'], priceFrom: 2999, mood: ['menacing', 'nocturnal'], url: 'https://karta.strdm.io/beat/b_1', coverUrl: 'https://cdn.test/cover.jpg', tallVideoUrl: 'https://cdn.test/short.mp4', wideVideoUrl: 'https://cdn.test/wide.mp4', youtubeVideoId: 'yt123' };
const plans = planCampaign(beat, { platforms: ['meta', 'tiktok', 'google'], dailyCap: 9000, totalCap: 63000, days: 7 }, templateCopy(beat), (p) => `arm_${p}`, Date.UTC(2026, 10, 3));
const plan = (p: string) => plans.find((x) => x.platform === p)!.plan as LaunchPlan;

test('planner: dancehall goes to the Caribbean diaspora, budgets add up, links carry the arm id', () => {
  assert.deepEqual(plan('meta').countries, ['JM', 'US', 'GB', 'CA', 'TT']);
  assert.equal(plans.reduce((s, p) => s + p.plan.dailyBudget, 0), 9000);
  assert.match(plan('tiktok').landingUrl, /kc=arm_tiktok&utm_source=tiktok/);
  assert.ok(plan('google').copy.headline.length <= 40 && plan('google').copy.longHeadline.length <= 90);
  assert.match(plan('meta').copy.primary, /100 BPM in Am/);
});

test('Meta: paused campaign → ad set → video → creative → ad with the right fields', async () => {
  const { http, calls } = recorder((c) => ({ id: `id${calls.length}`, data: [] }));
  const m = meta({ appId: 'app', appSecret: 'sec', http });
  const l = await m.launch({ accessToken: 'tok' }, { id: 'act_9', name: 'A', currency: 'USD', extra: { pageId: 'page_1' } }, plan('meta'));
  const [camp, adset, video, creative, ad] = calls;
  assert.match(camp.url, /graph\.facebook\.com\/v26\.0\/act_9\/campaigns$/);
  assert.equal(camp.body.objective, 'OUTCOME_TRAFFIC'); assert.equal(camp.body.status, 'PAUSED');
  assert.equal(adset.body.is_adset_budget_sharing_enabled, 'false');
  assert.equal(JSON.parse(adset.body.targeting).geo_locations.countries[0], 'JM');
  assert.equal(adset.body.daily_budget, String(plan('meta').dailyBudget));
  assert.equal(video.body.file_url, beat.tallVideoUrl);
  const spec = JSON.parse(creative.body.object_story_spec);
  assert.equal(spec.page_id, 'page_1'); assert.equal(spec.video_data.call_to_action.value.link, plan('meta').landingUrl);
  assert.equal(ad.body.status, 'PAUSED');
  assert.equal(l.budgetRef, l.groupId);
  await assert.rejects(m.launch({ accessToken: 'tok' }, { id: 'act_9', name: 'A', currency: 'USD' }, plan('meta')), /Facebook Page/);
});

test('TikTok: Access-Token header, campaign → upload by URL → identity → ad group ($20 min) → ad, all disabled', async () => {
  const replies: Record<string, unknown> = { '/campaign/create/': { campaign_id: 'c1' }, '/file/video/ad/upload/': [{ video_id: 'v1' }], '/identity/create/': { identity_id: 'i1' }, '/adgroup/create/': { adgroup_id: 'g1' }, '/ad/create/': { ad_ids: ['a1'] } };
  const { http, calls } = recorder((c) => ({ code: 0, message: 'OK', data: replies[new URL(c.url).pathname.replace('/open_api/v1.3', '')] ?? {} }));
  const t = tiktok({ appId: 'app', secret: 'sec', http });
  const l = await t.launch({ accessToken: 'tt' }, { id: 'adv1', name: 'A', currency: 'USD' }, { ...plan('tiktok'), dailyBudget: 900 });
  assert.ok(calls.every((c) => c.headers['access-token'] === 'tt'));
  const group = calls.find((c) => c.url.endsWith('/adgroup/create/'))!.body;
  assert.equal(group.budget, 20, 'raised to TikTok’s $20 minimum');
  assert.deepEqual(group.location_ids, ['3489940', '6252001', '2635167', '6251999', '3573591']);
  assert.equal(group.operation_status, 'DISABLE');
  const ad = calls.find((c) => c.url.endsWith('/ad/create/'))!.body.creatives[0];
  assert.equal(ad.video_id, 'v1'); assert.equal(ad.identity_id, 'i1'); assert.ok(ad.ad_text.length <= 100);
  assert.deepEqual(l, { platform: 'tiktok', campaignId: 'c1', groupId: 'g1', adIds: ['a1'], budgetRef: 'g1', extra: { videoId: 'v1', identityId: 'i1' } });
  const { http: h2 } = recorder(() => ({ code: 40001, message: 'Insufficient balance' }));
  await assert.rejects(tiktok({ appId: 'a', secret: 's', http: h2 }).launch({ accessToken: 'tt' }, { id: 'adv1', name: 'A', currency: 'USD' }, plan('tiktok')), /TikTok: Insufficient balance/);
});

test('Google: one Demand Gen mutate with budget, paused campaign, countries, ad group, YouTube + logo assets and the video ad', async () => {
  const { http, calls } = recorder((c) => {
    if (c.url.endsWith('cover.jpg')) return new Response(new Uint8Array([255, 216, 255, 0, 1, 2]));
    return { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/123/campaignBudgets/9' } }, { campaignResult: { resourceName: 'customers/123/campaigns/8' } }, { adGroupResult: { resourceName: 'customers/123/adGroups/7' } }, { adGroupAdResult: { resourceName: 'customers/123/adGroupAds/7~6' } }] };
  });
  const g = google({ clientId: 'c', clientSecret: 's', developerToken: 'dev', http });
  const l = await g.launch({ accessToken: 'ga' }, { id: '123-0000', name: 'A', currency: 'USD' }, plan('google'));
  const m = calls.find((c) => c.url.includes('googleAds:mutate'))!;
  assert.match(m.url, /googleads\.googleapis\.com\/v26\/customers\/1230000\/googleAds:mutate/);
  assert.equal(m.headers['developer-token'], 'dev');
  const ops = m.body.mutateOperations;
  const camp = ops.find((o: any) => o.campaignOperation).campaignOperation.create;
  assert.equal(camp.advertisingChannelType, 'DEMAND_GEN'); assert.equal(camp.status, 'PAUSED');
  assert.equal(ops.find((o: any) => o.campaignBudgetOperation).campaignBudgetOperation.create.explicitlyShared, false);
  assert.equal(ops.filter((o: any) => o.campaignCriterionOperation).length, 5);
  const ad = ops.find((o: any) => o.adGroupAdOperation).adGroupAdOperation.create.ad.demandGenVideoResponsiveAd;
  assert.equal(ad.videos[0].asset, 'customers/1230000/assets/-4'); assert.equal(ad.logoImages[0].asset, 'customers/1230000/assets/-5');
  assert.equal(ops.find((o: any) => o.assetOperation?.create.youtubeVideoAsset).assetOperation.create.youtubeVideoAsset.youtubeVideoId, 'yt123');
  assert.equal(l.campaignId, 'customers/123/campaigns/8'); assert.equal(l.budgetRef, 'customers/123/campaignBudgets/9');
});

test('conversions: hashed email + click ids go back to each platform', async () => {
  const conv = { email: ' Kemar@Artist.test ', clickId: 'CLICK', value: 2999, currency: 'usd', at: Date.UTC(2026, 10, 3, 12), orderId: 'o_1', url: 'https://karta.strdm.io/beat/b_1' };
  const hash = 'f0a3b8f6b88b1a6c7f2b7d2b8f6c1e3a'; // not asserted literally; just shape
  const { http: hm, calls: cm } = recorder(() => ({ events_received: 1 }));
  await meta({ appId: 'a', appSecret: 's', http: hm }).sendConversion!({ accessToken: 't' }, { id: 'act', name: '', currency: 'USD', extra: { pixelId: 'px1' } }, conv);
  const ev = JSON.parse(cm[0].body.data)[0];
  assert.match(cm[0].url, /\/px1\/events$/); assert.equal(ev.event_name, 'Purchase'); assert.equal(ev.custom_data.value, 29.99);
  assert.match(ev.user_data.em[0], /^[0-9a-f]{64}$/); assert.notEqual(ev.user_data.em[0], hash);
  const { http: ht, calls: ct } = recorder(() => ({ code: 0, data: {} }));
  await tiktok({ appId: 'a', secret: 's', http: ht }).sendConversion!({ accessToken: 't' }, { id: 'adv', name: '', currency: 'USD', extra: { pixelCode: 'PIX' } }, conv);
  assert.equal(ct[0].body.data[0].event, 'CompletePayment'); assert.equal(ct[0].body.data[0].user.ttclid, 'CLICK');
  const { http: hg, calls: cg } = recorder(() => ({ results: [{}] }));
  await google({ clientId: 'c', clientSecret: 's', developerToken: 'd', http: hg }).sendConversion!({ accessToken: 't' }, { id: '123', name: '', currency: 'USD', extra: { conversionAction: 'customers/123/conversionActions/5' } }, conv);
  assert.equal(cg[0].body.conversions[0].gclid, 'CLICK'); assert.equal(cg[0].body.conversions[0].conversionDateTime, '2026-11-03 12:00:00+00:00');
});
