// Generated from packages/ads/src by scripts/sync-ads.mjs. Edit there, then run npm run sync-ads.
// Meta (Facebook + Instagram) through the Marketing API v26.0.
// Campaign (OUTCOME_TRAFFIC) → ad set (link clicks, daily budget, countries, Advantage+ audience)
// → video uploaded by URL → creative (video + cover + copy + CTA) → ad. Everything is created PAUSED.
import { AdsError, sha256, type AdAccount, type AdPlatform, type Conversion, type Fetch, type LaunchPlan, type Launched, type Metrics, type Tokens } from './types';

export const META_VERSION = 'v26.0';

export interface MetaConfig { appId: string; appSecret: string; http?: Fetch; graph?: string }

export function meta(cfg: MetaConfig): AdPlatform {
  const http = cfg.http ?? fetch;
  const G = (cfg.graph ?? 'https://graph.facebook.com') + '/' + META_VERSION;

  async function call<T = Record<string, unknown>>(t: Tokens, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    body.set('access_token', t.accessToken);
    const url = method === 'GET' ? `${G}${path}?${body}` : `${G}${path}`;
    const res = await http(url, method === 'GET' ? {} : { method, body });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; error_user_msg?: string } };
    if (!res.ok || data.error) throw new AdsError('meta', data.error?.error_user_msg ?? data.error?.message ?? `HTTP ${res.status}`, res.status);
    return data;
  }

  return {
    id: 'meta',
    minDaily: 100,
    authUrl: (state, redirect) => `https://www.facebook.com/${META_VERSION}/dialog/oauth?` + new URLSearchParams({
      client_id: cfg.appId, redirect_uri: redirect, state, response_type: 'code',
      scope: 'ads_management,ads_read,business_management,pages_show_list,pages_read_engagement',
    }),
    async exchange(code, redirect) {
      const short = await call<{ access_token: string }>({ accessToken: '' }, 'GET', '/oauth/access_token', { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: redirect, code });
      // swap for a long-lived token (~60 days)
      const long = await call<{ access_token: string; expires_in?: number }>({ accessToken: '' }, 'GET', '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: short.access_token });
      return { accessToken: long.access_token, expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : undefined };
    },
    async accounts(t) {
      const [acts, pages] = await Promise.all([
        call<{ data: { id: string; name: string; currency: string; account_status: number }[] }>(t, 'GET', '/me/adaccounts', { fields: 'id,name,currency,account_status', limit: '50' }),
        call<{ data: { id: string; name: string }[] }>(t, 'GET', '/me/accounts', { fields: 'id,name', limit: '50' }),
      ]);
      const page = pages.data[0];
      // ads run as a Facebook Page; the first Page is the default and can be changed in settings
      return acts.data.filter((a) => a.account_status === 1).map((a): AdAccount => ({ id: a.id, name: a.name, currency: a.currency, extra: page ? { pageId: page.id, pageName: page.name } : {} }));
    },
    async launch(t, acct, p) {
      const pageId = acct.extra?.pageId;
      if (!pageId) throw new AdsError('meta', 'Connect a Facebook Page to this ad account first. Meta ads run as a Page.');
      if (!p.creative.tallVideoUrl) throw new AdsError('meta', 'This beat needs a 9:16 video. Generate artwork first.');
      const campaign = await call<{ id: string }>(t, 'POST', `/${acct.id}/campaigns`, {
        name: p.name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], buying_type: 'AUCTION',
      });
      const adset = await call<{ id: string }>(t, 'POST', `/${acct.id}/adsets`, {
        name: `${p.name} · ${p.countries.join(' ')}`, campaign_id: campaign.id, status: 'PAUSED',
        daily_budget: String(Math.max(100, p.dailyBudget)), is_adset_budget_sharing_enabled: false,
        billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        destination_type: 'WEBSITE',
        start_time: new Date(p.startAt).toISOString(), ...(p.endAt ? { end_time: new Date(p.endAt).toISOString() } : {}),
        targeting: { geo_locations: { countries: p.countries }, age_min: p.ageMin, targeting_automation: { advantage_audience: 1 } },
      });
      const video = await call<{ id: string }>(t, 'POST', `/${acct.id}/advideos`, { file_url: p.creative.tallVideoUrl, name: p.name });
      const creative = await call<{ id: string }>(t, 'POST', `/${acct.id}/adcreatives`, {
        name: p.name,
        object_story_spec: {
          page_id: pageId,
          video_data: {
            video_id: video.id, image_url: p.creative.coverUrl, title: p.copy.headline, message: p.copy.primary, link_description: p.copy.description,
            call_to_action: { type: p.copy.cta === 'SHOP_NOW' ? 'SHOP_NOW' : p.copy.cta === 'LISTEN_NOW' ? 'LISTEN_NOW' : 'LEARN_MORE', value: { link: p.landingUrl } },
          },
        },
      });
      const ad = await call<{ id: string }>(t, 'POST', `/${acct.id}/ads`, { name: p.name, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED' });
      return { platform: 'meta', campaignId: campaign.id, groupId: adset.id, adIds: [ad.id], budgetRef: adset.id, extra: { videoId: video.id, creativeId: creative.id } };
    },
    async metrics(t, _a, l): Promise<Metrics> {
      const r = await call<{ data: { spend?: string; impressions?: string; inline_link_clicks?: string; actions?: { action_type: string; value: string }[] }[] }>(t, 'GET', `/${l.groupId}/insights`, { fields: 'spend,impressions,inline_link_clicks,actions', date_preset: 'maximum' });
      const d = r.data[0] ?? {};
      const conv = (d.actions ?? []).filter((a) => /purchase/.test(a.action_type)).reduce((s, a) => s + Number(a.value), 0);
      return { spend: Math.round(Number(d.spend ?? 0) * 100), impressions: Number(d.impressions ?? 0), clicks: Number(d.inline_link_clicks ?? 0), platformConversions: conv };
    },
    async setDailyBudget(t, _a, l, cents) { await call(t, 'POST', `/${l.budgetRef}`, { daily_budget: String(Math.max(100, Math.round(cents))) }); },
    async setActive(t, _a, l, active) {
      const status = active ? 'ACTIVE' : 'PAUSED';
      await call(t, 'POST', `/${l.campaignId}`, { status });
      await call(t, 'POST', `/${l.groupId}`, { status });
      for (const id of l.adIds) await call(t, 'POST', `/${id}`, { status });
    },
    /** Conversions API: tells Meta a click turned into a license sale, so it can find more buyers. */
    async sendConversion(t, acct, c: Conversion) {
      const pixel = acct.extra?.pixelId;
      if (!pixel) return;
      await call(t, 'POST', `/${pixel}/events`, {
        data: [{
          event_name: 'Purchase', event_time: Math.floor(c.at / 1000), event_id: c.orderId, action_source: 'website', event_source_url: c.url,
          user_data: { ...(c.email ? { em: [await sha256(c.email)] } : {}), ...(c.clickId ? { fbc: `fb.1.${c.at}.${c.clickId}` } : {}), ...(c.ip ? { client_ip_address: c.ip } : {}), ...(c.userAgent ? { client_user_agent: c.userAgent } : {}) },
          custom_data: { value: c.value / 100, currency: c.currency.toUpperCase() },
        }],
      });
    },
  };
}
