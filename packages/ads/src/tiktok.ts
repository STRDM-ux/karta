// TikTok through the Business API v1.3 (header "Access-Token", JSON bodies, { code: 0, data } replies).
// Campaign (TRAFFIC) → video uploaded by URL → ad group (clicks, daily budget, countries) → ad.
// TikTok creates campaigns disabled; ad groups and ads are created disabled here too until approved.
import { AdsError, sha256, type AdAccount, type AdPlatform, type Conversion, type Fetch, type LaunchPlan, type Launched, type Metrics, type Tokens } from './types.js';

export interface TikTokConfig { appId: string; secret: string; http?: Fetch; base?: string }

/** TikTok location ids for the countries Karta targets most (TikTok uses its own geo ids). */
export const TIKTOK_LOCATIONS: Record<string, string> = {
  US: '6252001', GB: '2635167', CA: '6251999', JM: '3489940', TT: '3573591', NG: '2328926', GH: '2300660', KE: '192950', ZA: '953987', FR: '3017382', DE: '2921044', BR: '3469034',
};

export function tiktok(cfg: TikTokConfig): AdPlatform {
  const http = cfg.http ?? fetch;
  const B = (cfg.base ?? 'https://business-api.tiktok.com') + '/open_api/v1.3';

  async function call<T = Record<string, unknown>>(t: Tokens | null, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(t ? { 'Access-Token': t.accessToken } : {}) };
    const url = method === 'GET' ? `${B}${path}?${new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]))}` : `${B}${path}`;
    const res = await http(url, method === 'GET' ? { headers } : { method, headers, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: T };
    if (!res.ok || data.code !== 0) throw new AdsError('tiktok', data.message ?? `HTTP ${res.status}`, res.status);
    return data.data as T;
  }

  return {
    id: 'tiktok',
    minDaily: 2000, // TikTok's minimum daily ad group budget is $20
    authUrl: (state, redirect) => `https://business-api.tiktok.com/portal/auth?` + new URLSearchParams({ app_id: cfg.appId, state, redirect_uri: redirect }),
    async exchange(code) {
      const d = await call<{ access_token: string; advertiser_ids: string[] }>(null, 'POST', '/oauth2/access_token/', { app_id: cfg.appId, secret: cfg.secret, auth_code: code });
      return { accessToken: d.access_token };
    },
    async accounts(t) {
      const d = await call<{ list: { advertiser_id: string; advertiser_name: string }[] }>(t, 'GET', '/oauth2/advertiser/get/', { app_id: cfg.appId, secret: cfg.secret });
      const out: AdAccount[] = [];
      for (const a of d.list) {
        const info = await call<{ list: { currency: string; name: string }[] }>(t, 'GET', '/advertiser/info/', { advertiser_ids: [a.advertiser_id], fields: ['currency', 'name'] }).catch(() => ({ list: [] as { currency: string; name: string }[] }));
        out.push({ id: a.advertiser_id, name: a.advertiser_name, currency: info.list[0]?.currency ?? 'USD' });
      }
      return out;
    },
    async launch(t, acct, p) {
      if (!p.creative.tallVideoUrl) throw new AdsError('tiktok', 'This beat needs a 9:16 video. Generate artwork first.');
      const locations = p.countries.map((c) => TIKTOK_LOCATIONS[c]).filter(Boolean);
      if (!locations.length) throw new AdsError('tiktok', `None of ${p.countries.join(', ')} are set up for TikTok targeting yet.`);
      const campaign = await call<{ campaign_id: string }>(t, 'POST', '/campaign/create/', {
        advertiser_id: acct.id, campaign_name: p.name, objective_type: 'TRAFFIC', budget_mode: 'BUDGET_MODE_INFINITE',
      });
      const video = await call<{ video_id: string }[] | { video_id: string }>(t, 'POST', '/file/video/ad/upload/', {
        advertiser_id: acct.id, upload_type: 'UPLOAD_BY_URL', video_url: p.creative.tallVideoUrl, file_name: `${p.name}.mp4`.slice(0, 100),
      });
      const videoId = Array.isArray(video) ? video[0].video_id : video.video_id;
      const identity = acct.extra?.identityId
        ? { identity_type: 'CUSTOMIZED_USER', identity_id: acct.extra.identityId }
        : await call<{ identity_id: string }>(t, 'POST', '/identity/create/', { advertiser_id: acct.id, display_name: p.creative.businessName.slice(0, 40) }).then((r) => ({ identity_type: 'CUSTOMIZED_USER', identity_id: r.identity_id }));
      const group = await call<{ adgroup_id: string }>(t, 'POST', '/adgroup/create/', {
        advertiser_id: acct.id, campaign_id: campaign.campaign_id, adgroup_name: `${p.name} · ${p.countries.join(' ')}`,
        promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_TIKTOK'],
        location_ids: locations, age_groups: ageGroups(p.ageMin),
        budget_mode: 'BUDGET_MODE_DAY', budget: Math.max(20, p.dailyBudget / 100),
        schedule_type: p.endAt ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
        schedule_start_time: tt(p.startAt), ...(p.endAt ? { schedule_end_time: tt(p.endAt) } : {}),
        optimization_goal: 'CLICK', billing_event: 'CPC', bid_type: 'BID_TYPE_NO_BID', pacing: 'PACING_MODE_SMOOTH', operation_status: 'DISABLE',
      });
      const ad = await call<{ ad_ids: string[] }>(t, 'POST', '/ad/create/', {
        advertiser_id: acct.id, adgroup_id: group.adgroup_id,
        creatives: [{ ad_name: p.name, ad_format: 'SINGLE_VIDEO', video_id: videoId, ...identity, ad_text: p.copy.primary.slice(0, 100), call_to_action: p.copy.cta === 'SHOP_NOW' ? 'SHOP_NOW' : p.copy.cta === 'LISTEN_NOW' ? 'LISTEN_NOW' : 'LEARN_MORE', landing_page_url: p.landingUrl, operation_status: 'DISABLE' }],
      });
      return { platform: 'tiktok', campaignId: campaign.campaign_id, groupId: group.adgroup_id, adIds: ad.ad_ids, budgetRef: group.adgroup_id, extra: { videoId, identityId: identity.identity_id } };
    },
    async metrics(t, acct, l): Promise<Metrics> {
      const d = await call<{ list: { metrics: Record<string, string> }[] }>(t, 'GET', '/report/integrated/get/', {
        advertiser_id: acct.id, report_type: 'BASIC', data_level: 'AUCTION_ADGROUP', dimensions: ['adgroup_id'],
        metrics: ['spend', 'impressions', 'clicks', 'conversion'], query_lifetime: true, filtering: [{ field_name: 'adgroup_ids', filter_type: 'IN', filter_value: JSON.stringify([l.groupId]) }],
      });
      const m = d.list[0]?.metrics ?? {};
      return { spend: Math.round(Number(m.spend ?? 0) * 100), impressions: Number(m.impressions ?? 0), clicks: Number(m.clicks ?? 0), platformConversions: Number(m.conversion ?? 0) };
    },
    async setDailyBudget(t, acct, l, cents) { await call(t, 'POST', '/adgroup/budget/update/', { advertiser_id: acct.id, budget: [{ adgroup_id: l.groupId, budget: Math.max(20, cents / 100) }] }); },
    async setActive(t, acct, l, active) {
      const operation_status = active ? 'ENABLE' : 'DISABLE';
      await call(t, 'POST', '/campaign/status/update/', { advertiser_id: acct.id, campaign_ids: [l.campaignId], operation_status });
      await call(t, 'POST', '/adgroup/status/update/', { advertiser_id: acct.id, adgroup_ids: [l.groupId], operation_status });
      await call(t, 'POST', '/ad/status/update/', { advertiser_id: acct.id, ad_ids: l.adIds, operation_status });
    },
    /** Events API: reports the license sale back so TikTok can optimise toward buyers. */
    async sendConversion(t, acct, c: Conversion) {
      const pixel = acct.extra?.pixelCode;
      if (!pixel) return;
      await call(t, 'POST', '/event/track/', {
        event_source: 'web', event_source_id: pixel,
        data: [{ event: 'CompletePayment', event_time: Math.floor(c.at / 1000), event_id: c.orderId,
          user: { ...(c.email ? { email: await sha256(c.email) } : {}), ...(c.clickId ? { ttclid: c.clickId } : {}), ...(c.ip ? { ip: c.ip } : {}), ...(c.userAgent ? { user_agent: c.userAgent } : {}) },
          page: { url: c.url }, properties: { value: c.value / 100, currency: c.currency.toUpperCase(), content_type: 'product' } }],
      });
    },
  };
}

const tt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
function ageGroups(min: number): string[] {
  const all: [number, string][] = [[13, 'AGE_13_17'], [18, 'AGE_18_24'], [25, 'AGE_25_34'], [35, 'AGE_35_44'], [45, 'AGE_45_54'], [55, 'AGE_55_100']];
  return all.filter(([a]) => a >= Math.max(18, min)).map(([, g]) => g);
}
