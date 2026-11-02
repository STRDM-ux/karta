export type PlatformId = 'meta' | 'tiktok' | 'google';

export type Fetch = typeof fetch;

export interface Tokens { accessToken: string; refreshToken?: string; expiresAt?: number }

export interface AdAccount { id: string; name: string; currency: string; extra?: Record<string, string> }

/** What the planner decides and the adapters launch. Money is in cents (account currency). */
export interface LaunchPlan {
  name: string;
  landingUrl: string;            // Karta beat page with ?kc=<arm id>; platforms add their click id
  countries: string[];           // ISO-3166 alpha-2
  ageMin: number;
  interests: string[];           // plain keywords; adapters map them where the platform allows
  dailyBudget: number;
  startAt: number;               // ms
  endAt?: number;
  copy: { primary: string; headline: string; longHeadline: string; description: string; cta: 'LISTEN_NOW' | 'SHOP_NOW' | 'LEARN_MORE' };
  creative: { tallVideoUrl?: string; wideVideoUrl?: string; coverUrl: string; youtubeVideoId?: string; businessName: string };
}

/** IDs needed to manage what was created. */
export interface Launched { platform: PlatformId; campaignId: string; groupId: string; adIds: string[]; budgetRef: string; extra?: Record<string, string> }

export interface Metrics { spend: number; impressions: number; clicks: number; platformConversions: number }

export interface Conversion { email?: string; clickId?: string; value: number; currency: string; at: number; orderId: string; url: string; ip?: string; userAgent?: string }

export interface AdPlatform {
  id: PlatformId;
  authUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<Tokens>;
  refresh?(t: Tokens): Promise<Tokens>;
  accounts(t: Tokens): Promise<AdAccount[]>;
  launch(t: Tokens, account: AdAccount, plan: LaunchPlan): Promise<Launched>;
  metrics(t: Tokens, account: AdAccount, l: Launched): Promise<Metrics>;
  setDailyBudget(t: Tokens, account: AdAccount, l: Launched, cents: number): Promise<void>;
  setActive(t: Tokens, account: AdAccount, l: Launched, active: boolean): Promise<void>;
  sendConversion?(t: Tokens, account: AdAccount, c: Conversion): Promise<void>;
  /** Smallest daily budget the platform accepts for one ad set / ad group, in cents. */
  minDaily: number;
}

export class AdsError extends Error {
  constructor(readonly platform: PlatformId, message: string, readonly status = 400) { super(`${label(platform)}: ${message}`); }
}

export const label = (p: PlatformId) => ({ meta: 'Meta', tiktok: 'TikTok', google: 'Google Ads' }[p]);

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
