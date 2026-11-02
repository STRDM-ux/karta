# @karta/ads: the auto ads runner

Promotes a beat on **TikTok** (Business API v1.3), **Meta** (Instagram/Facebook, Marketing API v26.0) and
**YouTube** (Google Ads API v26, Demand Gen), then moves the budget toward whatever sells licenses.

## What happens when a producer presses "Promote"

1. **Plan** (`planner.ts`)
   - **Markets** come from the genre. For example, dancehall goes to JM, US, GB, CA and TT; drill to GB, US, CA, FR and DE.
   - **Ad copy** is written from the beat itself (title, BPM, key, mood, price). With `ANTHROPIC_API_KEY` set,
     Claude writes it, with length limits enforced; otherwise a template does. The producer can edit it.
   - **Starting budget split:** TikTok 40%, Meta 35%, YouTube 25%, raised to each platform's minimum daily
     budget (TikTok $20, Google $5, Meta $1).
2. **Launch, paused** (`meta.ts`, `tiktok.ts`, `google.ts`)
   - **Meta:** campaign `OUTCOME_TRAFFIC` → ad set (link clicks, Advantage+ audience, countries, ad set
     budget with `is_adset_budget_sharing_enabled: false`) → video by URL → creative from the Page → ad.
   - **TikTok:** campaign `TRAFFIC` → video by URL → identity → ad group (CPC, smooth pacing) → ad. All disabled.
   - **Google:** the cinematic cut is first uploaded to the producer's YouTube as unlisted, using the same
     Google sign-in. Then a single `googleAds:mutate` creates the budget, a paused `DEMAND_GEN` campaign,
     the countries, an ad group, the YouTube and logo assets, and a `demandGenVideoResponsiveAd`.
3. **Go live.** The producer confirms the caps. Nothing spends before this.
4. **Optimize every 6 hours** (`optimizer.ts`, run by a Durable Object alarm)
   - **Thompson sampling** on revenue per dollar: conversion rate ~ Beta(sales, clicks − sales), and cost per
     click drawn around what has actually been paid. Budget follows the odds that each platform is the best.
   - An **exploration floor** protects platforms still in their learning budget.
   - Budgets move **±30% per run at most**, so platforms don't restart their learning phase.
   - It **pauses** a platform that has spent about 3 leases' worth with no sale and has under 5% odds of being best.
   - The **daily cap**, **total cap**, end date and platform minimums are hard limits. Spend is paced so the
     total lasts the whole run.
   - Every change is logged in plain language, for example: "TikTok: Raised $42 → $54/day: 28 sales from 693 clicks…".
5. **Attribution.** Ad links carry `?kc=<arm>`, and the platforms add `ttclid`/`fbclid`/`gclid`. The store keeps
   them for 30 days, so a checkout is credited to the ad that brought the buyer. The sale is then reported back
   through Meta's Conversions API, TikTok's Events API and Google's click conversion upload, with the email
   SHA-256 hashed.

Karta's own paid orders are the source of truth for sales. Platform-reported conversions are not used.

## Setup (Karta backend secrets)

| Secret | For |
|---|---|
| `META_APP_ID`, `META_APP_SECRET` | Meta app with Marketing API access (`ads_management`, `pages_show_list`) |
| `TIKTOK_APP_ID`, `TIKTOK_SECRET` | TikTok for Business developer app |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` (+ `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for an MCC) | Google Ads API + YouTube upload scope |
| `ADS_TOKEN_KEY` | base64 32-byte key; ad account tokens are stored AES-GCM encrypted |
| `PUBLIC_API_URL` | the backend's public URL (OAuth callback `…/ads/callback/<platform>`, media URLs the platforms fetch) |
| `ANTHROPIC_API_KEY`, `ADS_COPY_MODEL` | optional: Claude writes the ad copy |
| `ADS_SANDBOX=1` | simulated platforms: the whole flow with no real ad accounts or spend |

Register `https://<backend>/ads/callback/meta`, `/tiktok` and `/google` as OAuth redirect URLs in each developer console.

## Tests

- `npm test -w @karta/ads`
  - Request shapes for every platform, recorded against the documented fields.
  - Conversion uploads.
  - A two-week optimizer simulation with hidden conversion rates, checking that budget converges on the
    platform that sells and that no cap is ever broken.
- `functions/test/ads.test.mjs`, against the backend in sandbox mode
  - Connect, plan, paused launch, attributed purchase, go live, simulated days, optimizer moves, pause.

The platform adapters follow the published API docs, but they haven't been run against live ad accounts yet.
Try each platform with a small budget, or in its sandbox or test account, before using real money.
