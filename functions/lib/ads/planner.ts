// Generated from packages/ads/src by scripts/sync-ads.mjs. Edit there, then run npm run sync-ads.
// The planner: turns a beat into a launch plan for each connected platform. Audiences come from the
// genre (where its buyers are), copy comes from the beat's own facts and mood. If an Anthropic key is
// configured, Claude rewrites the copy in the producer's voice; the template copy is always the fallback.
import type { LaunchPlan, PlatformId, Fetch } from './types';

export interface BeatForAds {
  id: string; title: string; producer: string; genre: string; bpm: number; key: string; tags: string[];
  priceFrom: number; // cents
  mood?: string[];   // from the art engine's visual DNA
  url: string;       // public beat page
  coverUrl: string; tallVideoUrl?: string; wideVideoUrl?: string; youtubeVideoId?: string;
}

export interface CampaignSettings {
  platforms: PlatformId[];
  dailyCap: number;      // cents per day across all platforms
  totalCap: number;      // cents for the whole campaign
  days: number;
  countries?: string[];  // overrides the genre's markets
  ageMin?: number;
}

/** Where a genre's buyers are, and what they're into. */
const MARKETS: Record<string, { countries: string[]; interests: string[] }> = {
  dancehall: { countries: ['JM', 'US', 'GB', 'CA', 'TT'], interests: ['Dancehall', 'Reggae', 'Jamaican music', 'Music production', 'Rapping'] },
  reggae: { countries: ['JM', 'US', 'GB', 'CA', 'BR'], interests: ['Reggae', 'Roots reggae', 'Dancehall', 'Songwriting'] },
  soca: { countries: ['TT', 'JM', 'US', 'CA', 'GB'], interests: ['Soca music', 'Carnival', 'Caribbean music'] },
  afrobeats: { countries: ['NG', 'GH', 'GB', 'US', 'CA', 'KE'], interests: ['Afrobeats', 'African music', 'Music production', 'Songwriting'] },
  amapiano: { countries: ['ZA', 'NG', 'GB', 'KE', 'GH'], interests: ['Amapiano', 'House music', 'DJ'] },
  drill: { countries: ['GB', 'US', 'CA', 'FR', 'DE'], interests: ['UK drill', 'Hip hop music', 'Rapping', 'Grime'] },
  trap: { countries: ['US', 'CA', 'GB', 'DE', 'FR'], interests: ['Trap music', 'Hip hop music', 'Rapping', 'Music production'] },
  'hip hop': { countries: ['US', 'CA', 'GB'], interests: ['Hip hop music', 'Rapping', 'Freestyle rap'] },
  'r&b': { countries: ['US', 'GB', 'CA'], interests: ['Contemporary R&B', 'Singing', 'Songwriting'] },
};

/** How budget is split before there's any data: TikTok and Reels carry beat discovery; YouTube is search intent. */
const PRIOR_SPLIT: Record<PlatformId, number> = { tiktok: 0.4, meta: 0.35, google: 0.25 };

export function templateCopy(b: BeatForAds): LaunchPlan['copy'] {
  const price = (b.priceFrom / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: b.priceFrom % 100 ? 2 : 0 });
  const vibe = b.mood?.slice(0, 2).join(', ') || 'hard-hitting';
  const genre = b.genre || 'instrumental';
  const typeTag = b.tags.find((t) => /type beat/i.test(t));
  return {
    primary: `${b.title}: a ${vibe} ${genre.toLowerCase()} beat at ${b.bpm} BPM in ${b.key}. Lease it from ${price} and get the files the moment you pay.`,
    headline: `${b.title} · ${b.bpm} BPM ${genre}`.slice(0, 40),
    longHeadline: `${typeTag ? typeTag + ': ' : ''}${b.title}, ${vibe} ${genre.toLowerCase()} by ${b.producer}`.slice(0, 90),
    description: `Leases from ${price}. Exclusive rights available. Instant download.`.slice(0, 90),
    cta: 'LISTEN_NOW',
  };
}

/** Optional: Claude writes the copy. Falls back to the template on any problem. */
export async function aiCopy(b: BeatForAds, o: { apiKey?: string; model?: string; http?: Fetch } = {}): Promise<LaunchPlan['copy']> {
  const base = templateCopy(b);
  if (!o.apiKey) return base;
  try {
    const res = await (o.http ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: o.model ?? 'claude-sonnet-5-5', max_tokens: 400,
        messages: [{ role: 'user', content: `Write ad copy selling a beat lease to recording artists. Facts: title "${b.title}", producer ${b.producer}, ${b.genre}, ${b.bpm} BPM, key ${b.key}, mood ${b.mood?.join(', ') || 'n/a'}, tags ${b.tags.join(', ') || 'none'}, leases from $${(b.priceFrom / 100).toFixed(2)}. Speak to artists, plain and confident, no hashtags, no emojis, don't invent facts or numbers.\nReply with JSON only: {"primary": ≤125 chars, "headline": ≤40, "longHeadline": ≤90, "description": ≤90}` }],
      }),
    });
    const d = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = d.content?.find((c) => c.type === 'text')?.text ?? '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Partial<LaunchPlan['copy']>;
    const ok = (s: unknown, n: number) => typeof s === 'string' && s.trim().length > 3 && s.length <= n;
    return {
      primary: ok(j.primary, 125) ? j.primary!.trim() : base.primary,
      headline: ok(j.headline, 40) ? j.headline!.trim() : base.headline,
      longHeadline: ok(j.longHeadline, 90) ? j.longHeadline!.trim() : base.longHeadline,
      description: ok(j.description, 90) ? j.description!.trim() : base.description,
      cta: base.cta,
    };
  } catch {
    return base;
  }
}

export interface PlannedArm { platform: PlatformId; plan: LaunchPlan; reason: string }

export function planCampaign(b: BeatForAds, s: CampaignSettings, copy: LaunchPlan['copy'], armId: (p: PlatformId) => string, now = Date.now()): PlannedArm[] {
  const market = MARKETS[b.genre.toLowerCase()] ?? { countries: ['US', 'GB', 'CA'], interests: ['Music production', 'Rapping', 'Songwriting'] };
  const countries = s.countries?.length ? s.countries : market.countries;
  const usable = s.platforms.filter((p) => (p === 'google' ? !!(b.youtubeVideoId || b.wideVideoUrl) : !!b.tallVideoUrl));
  const share = usable.reduce((n, p) => n + PRIOR_SPLIT[p], 0) || 1;
  return usable.map((p) => {
    const daily = Math.round((s.dailyCap * PRIOR_SPLIT[p]) / share);
    const u = new URL(b.url);
    u.searchParams.set('kc', armId(p));
    u.searchParams.set('utm_source', p);
    u.searchParams.set('utm_medium', 'paid');
    u.searchParams.set('utm_campaign', `karta-${b.id}`);
    return {
      platform: p,
      reason: `${Math.round((PRIOR_SPLIT[p] / share) * 100)}% to start: ${p === 'tiktok' ? 'beat discovery on TikTok is strongest for artists' : p === 'meta' ? 'Reels and Instagram reach artists who follow producers' : 'YouTube catches artists searching for type beats'}. Markets for ${b.genre || 'this beat'}: ${countries.join(', ')}.`,
      plan: {
        name: `Karta · ${b.title}`, landingUrl: u.toString(), countries, ageMin: s.ageMin ?? 18, interests: market.interests,
        dailyBudget: daily, startAt: now, endAt: now + s.days * 86_400_000, copy,
        creative: { tallVideoUrl: b.tallVideoUrl, wideVideoUrl: b.wideVideoUrl, coverUrl: b.coverUrl, youtubeVideoId: b.youtubeVideoId, businessName: b.producer },
      },
    };
  });
}

export { MARKETS };
