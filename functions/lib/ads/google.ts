// Generated from packages/ads/src by scripts/sync-ads.mjs. Edit there, then run npm run sync-ads.
// Google Ads API v26 (REST). YouTube ads run as Demand Gen campaigns: budget → campaign
// (DEMAND_GEN, Maximize Clicks, paused) → countries → ad group → YouTube video + logo assets → video
// responsive ad, all in one googleAds:mutate with temporary ids. The video must be on YouTube, so the
// runner first uploads the cinematic cut to the producer's channel as unlisted (same Google sign-in).
import { AdsError, sha256, type AdAccount, type AdPlatform, type Conversion, type Fetch, type LaunchPlan, type Launched, type Metrics, type Tokens } from './types';

export const GOOGLE_ADS_VERSION = 'v26';

export interface GoogleConfig { clientId: string; clientSecret: string; developerToken: string; loginCustomerId?: string; http?: Fetch; base?: string }

/** Google geo target constants. */
export const GOOGLE_GEO: Record<string, number> = { US: 2840, GB: 2826, CA: 2124, JM: 2388, TT: 2780, NG: 2566, GH: 2288, KE: 2404, ZA: 2710, FR: 2250, DE: 2276, BR: 2076 };

export function google(cfg: GoogleConfig): AdPlatform & { uploadToYouTube(t: Tokens, videoUrl: string, title: string, description: string): Promise<string> } {
  const http = cfg.http ?? fetch;
  const A = (cfg.base ?? 'https://googleads.googleapis.com') + '/' + GOOGLE_ADS_VERSION;

  async function ads<T = Record<string, unknown>>(t: Tokens, method: 'GET' | 'POST', path: string, body?: unknown, customer?: string): Promise<T> {
    const res = await http(`${A}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t.accessToken}`, 'developer-token': cfg.developerToken, 'Content-Type': 'application/json',
        ...(cfg.loginCustomerId ? { 'login-customer-id': cfg.loginCustomerId } : customer ? { 'login-customer-id': customer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; details?: { errors?: { message?: string }[] }[] } };
    if (!res.ok) {
      const detail = data.error?.details?.[0]?.errors?.[0]?.message ?? data.error?.message ?? `HTTP ${res.status}`;
      throw new AdsError('google', detail, res.status);
    }
    return data;
  }

  const micros = (cents: number) => String(Math.round(cents) * 10_000);

  return {
    id: 'google',
    minDaily: 500,
    authUrl: (state, redirect) => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirect, response_type: 'code', state, access_type: 'offline', prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/youtube.upload',
    }),
    async exchange(code, redirect) {
      const res = await http('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
      const d = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
      if (!d.access_token) throw new AdsError('google', d.error_description ?? 'Google sign-in failed');
      return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    },
    async refresh(t) {
      if (!t.refreshToken) return t;
      const res = await http('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ refresh_token: t.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' }) });
      const d = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!d.access_token) throw new AdsError('google', 'Google sign-in expired. Reconnect Google Ads.', 401);
      return { ...t, accessToken: d.access_token, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    },
    async accounts(t) {
      const r = await ads<{ resourceNames: string[] }>(t, 'GET', '/customers:listAccessibleCustomers');
      const out: AdAccount[] = [];
      for (const rn of r.resourceNames.slice(0, 20)) {
        const id = rn.split('/')[1];
        const q = await ads<{ results?: { customer: { descriptiveName?: string; currencyCode: string; manager?: boolean } }[] }>(t, 'POST', `/customers/${id}/googleAds:search`, { query: 'SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer' }, id).catch(() => ({ results: [] }));
        const c = q.results?.[0]?.customer;
        if (c && !c.manager) out.push({ id, name: c.descriptiveName ?? id, currency: c.currencyCode });
      }
      return out;
    },
    async uploadToYouTube(t, videoUrl, title, description) {
      const file = await http(videoUrl);
      if (!file.ok) throw new AdsError('google', `Couldn't read the video to put on YouTube (${file.status}).`);
      const bytes = await file.arrayBuffer();
      const init = await http('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(bytes.byteLength) },
        body: JSON.stringify({ snippet: { title: title.slice(0, 100), description, categoryId: '10' }, status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false } }),
      });
      const loc = init.headers.get('location');
      if (!init.ok || !loc) throw new AdsError('google', `YouTube upload didn't start (${init.status}). Is a YouTube channel linked to this Google account?`);
      const up = await http(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: bytes });
      const v = (await up.json().catch(() => ({}))) as { id?: string };
      if (!up.ok || !v.id) throw new AdsError('google', `YouTube upload failed (${up.status}).`);
      return v.id;
    },
    async launch(t, acct, p) {
      const cid = acct.id.replace(/-/g, '');
      const youtubeId = p.creative.youtubeVideoId;
      if (!youtubeId) throw new AdsError('google', 'The video has to be on YouTube first.');
      const logo = await http(p.creative.coverUrl).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .catch((e) => { throw new AdsError('google', `Couldn't read the cover for the logo image (${(e as Error).message}).`); });
      const rn = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
      const geos = p.countries.map((c) => GOOGLE_GEO[c]).filter(Boolean);
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const ops: unknown[] = [
        { campaignBudgetOperation: { create: { resourceName: rn('campaignBudgets', 1), name: `${p.name} budget ${Date.now()}`, amountMicros: micros(Math.max(500, p.dailyBudget)), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
        { campaignOperation: { create: {
          resourceName: rn('campaigns', 2), name: p.name, status: 'PAUSED', advertisingChannelType: 'DEMAND_GEN', campaignBudget: rn('campaignBudgets', 1),
          targetSpend: {}, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          startDate: day(p.startAt), ...(p.endAt ? { endDate: day(p.endAt) } : {}),
        } } },
        ...geos.map((g) => ({ campaignCriterionOperation: { create: { campaign: rn('campaigns', 2), location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
        { adGroupOperation: { create: { resourceName: rn('adGroups', 3), name: `${p.name} · ${p.countries.join(' ')}`, campaign: rn('campaigns', 2), status: 'ENABLED' } } },
        { assetOperation: { create: { resourceName: rn('assets', 4), name: `${p.name} video ${youtubeId}`, youtubeVideoAsset: { youtubeVideoId: youtubeId } } } },
        { assetOperation: { create: { resourceName: rn('assets', 5), name: `${p.name} logo ${Date.now()}`, imageAsset: { data: b64(logo) } } } },
        { adGroupAdOperation: { create: { adGroup: rn('adGroups', 3), status: 'ENABLED', ad: {
          name: p.name, finalUrls: [p.landingUrl],
          demandGenVideoResponsiveAd: {
            headlines: [{ text: p.copy.headline.slice(0, 40) }], longHeadlines: [{ text: p.copy.longHeadline.slice(0, 90) }], descriptions: [{ text: p.copy.description.slice(0, 90) }],
            videos: [{ asset: rn('assets', 4) }], logoImages: [{ asset: rn('assets', 5) }], businessName: { text: p.creative.businessName.slice(0, 25) },
          },
        } } } },
      ];
      const r = await ads<{ mutateOperationResponses: Record<string, { resourceName: string }>[] }>(t, 'POST', `/customers/${cid}/googleAds:mutate`, { mutateOperations: ops }, cid);
      const names = r.mutateOperationResponses.map((x) => Object.values(x)[0]?.resourceName ?? '');
      const find = (kind: string) => names.find((n) => n.includes(`/${kind}/`)) ?? '';
      return { platform: 'google', campaignId: find('campaigns'), groupId: find('adGroups'), adIds: [find('adGroupAds')].filter(Boolean), budgetRef: find('campaignBudgets'), extra: { youtubeId } };
    },
    async metrics(t, acct, l): Promise<Metrics> {
      const cid = acct.id.replace(/-/g, '');
      const r = await ads<{ results?: { metrics: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number } }[] }>(t, 'POST', `/customers/${cid}/googleAds:search`, {
        query: `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.resource_name = '${l.campaignId}'`,
      }, cid);
      const m = r.results?.[0]?.metrics ?? {};
      return { spend: Math.round(Number(m.costMicros ?? 0) / 10_000), impressions: Number(m.impressions ?? 0), clicks: Number(m.clicks ?? 0), platformConversions: Number(m.conversions ?? 0) };
    },
    async setDailyBudget(t, acct, l, cents) {
      const cid = acct.id.replace(/-/g, '');
      await ads(t, 'POST', `/customers/${cid}/campaignBudgets:mutate`, { operations: [{ update: { resourceName: l.budgetRef, amountMicros: micros(Math.max(500, cents)) }, updateMask: 'amount_micros' }] }, cid);
    },
    async setActive(t, acct, l, active) {
      const cid = acct.id.replace(/-/g, '');
      await ads(t, 'POST', `/customers/${cid}/campaigns:mutate`, { operations: [{ update: { resourceName: l.campaignId, status: active ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }] }, cid);
    },
    /** Offline click conversion upload: needs a gclid and the conversion action set in account settings. */
    async sendConversion(t, acct, c: Conversion) {
      const action = acct.extra?.conversionAction;
      if (!action || !c.clickId) return;
      const cid = acct.id.replace(/-/g, '');
      const dt = new Date(c.at).toISOString().replace('T', ' ').slice(0, 19) + '+00:00';
      await ads(t, 'POST', `/customers/${cid}:uploadClickConversions`, {
        conversions: [{ gclid: c.clickId, conversionAction: action, conversionDateTime: dt, conversionValue: c.value / 100, currencyCode: c.currency.toUpperCase(), orderId: c.orderId,
          ...(c.email ? { userIdentifiers: [{ hashedEmail: await sha256(c.email) }] } : {}) }],
        partialFailure: true,
      }, cid);
    },
  };
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
