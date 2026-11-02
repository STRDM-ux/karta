// The budget optimizer. Every few hours it looks at what each platform has spent and how many
// license sales Karta saw from its clicks, then moves the daily budget toward what's selling:
//
//  • Thompson sampling. For each arm, draw a plausible conversion rate (Beta on sales/clicks) and a
//    plausible cost per click (around what's been paid so far), turn that into revenue per dollar, and
//    count how often each arm comes out on top. The budget follows those odds.
//  • Every arm keeps an exploration floor until it has spent enough to judge (its learning budget).
//  • Budgets move at most ±30% per run: Meta, TikTok and Google all restart learning on big jumps.
//  • An arm that has spent several sales' worth with no sale, and is very unlikely to be best, is paused.
//  • Hard limits always win: the daily cap, the total cap, and each platform's minimum daily budget.
// Every decision comes back with a plain-language reason for the producer's activity log.

import type { PlatformId } from './types.js';

export interface Arm {
  id: string; platform: PlatformId; active: boolean;
  dailyBudget: number; minDaily: number;    // cents
  spend: number; clicks: number; impressions: number;
  sales: number; revenue: number;           // from Karta's own attribution, not the platform's
}

export interface Policy {
  dailyCap: number; totalCap: number; totalSpent: number; daysLeft: number;
  avgOrder: number;                         // cents; the beat's typical license price
  maxStep?: number;                         // default 0.3
  exploreFloor?: number;                    // default 0.12 of the day's budget per learning arm
  samples?: number;                         // default 4000
  seed?: number;
}

export interface Decision {
  armId: string; platform: PlatformId; action: 'keep' | 'raise' | 'lower' | 'pause' | 'resume';
  from: number; to: number; pBest: number; reason: string;
}

export interface Plan { decisions: Decision[]; dailyTarget: number; stopAll: boolean; summary: string }

export function optimize(arms: Arm[], p: Policy): Plan {
  const step = p.maxStep ?? 0.3, floor = p.exploreFloor ?? 0.12, N = p.samples ?? 4000;
  const rnd = mulberry32(p.seed ?? 7);
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const remaining = p.totalCap - p.totalSpent;
  const live = arms.filter((a) => a.active || a.spend === 0);
  const minSum = live.reduce((s, a) => s + a.minDaily, 0);

  if (remaining <= 0 || remaining < Math.min(...arms.map((a) => a.minDaily))) {
    return {
      stopAll: true, dailyTarget: 0, summary: `The campaign budget of ${money(p.totalCap)} is used up, so every platform is paused.`,
      decisions: arms.map((a) => ({ armId: a.id, platform: a.platform, action: a.active ? 'pause' : 'keep', from: a.dailyBudget, to: 0, pBest: 0, reason: 'Total budget reached.' })),
    };
  }

  // the day's budget: never above the daily cap, and paced so the total lasts the remaining days
  // (platform minimums may lift it, but never past what's left of the total)
  const dailyTarget = Math.min(remaining, Math.max(Math.min(p.dailyCap, Math.floor(remaining / Math.max(1, p.daysLeft))), Math.min(minSum, p.dailyCap)));
  const learning = (a: Arm) => a.spend < Math.max(2 * p.avgOrder, 1500);

  // Thompson sampling on revenue per dollar
  const wins = new Map<string, number>(arms.map((a) => [a.id, 0]));
  const priorCpc = 60; // cents, before any clicks
  for (let i = 0; i < N; i++) {
    let best = '', bestV = -1;
    for (const a of live) {
      const cr = beta(rnd, 1 + a.sales, 1 + Math.max(0, a.clicks - a.sales) + 20); // prior ≈ 1 sale per ~20 clicks at most
      const cpc0 = a.clicks > 0 ? a.spend / a.clicks : priorCpc;
      const cpc = cpc0 * Math.exp(gauss(rnd) * (1 / Math.sqrt(1 + a.clicks)) * 0.8);
      const v = (cr * Math.max(1, a.revenue / Math.max(1, a.sales) || p.avgOrder)) / Math.max(1, cpc);
      if (v > bestV) { bestV = v; best = a.id; }
    }
    wins.set(best, (wins.get(best) ?? 0) + 1);
  }
  const pBest = (a: Arm) => (wins.get(a.id) ?? 0) / N;

  const decisions: Decision[] = [];
  const keep: Arm[] = [];
  for (const a of arms) {
    const pb = pBest(a);
    const others = arms.filter((x) => x.id !== a.id && (x.active || x.spend === 0));
    const deadWeight = a.sales === 0 && a.spend >= 3 * p.avgOrder && pb < 0.05 && others.length > 0;
    if (a.active && deadWeight) {
      decisions.push({ armId: a.id, platform: a.platform, action: 'pause', from: a.dailyBudget, to: 0, pBest: pb, reason: `Paused: spent ${money(a.spend)} for ${a.clicks} clicks and no sales. That's ${Math.round(a.spend / p.avgOrder)}× the price of a lease, and it has a ${Math.round(pb * 100)}% chance of being the best platform.` });
      continue;
    }
    if (!a.active && a.spend > 0) { decisions.push({ armId: a.id, platform: a.platform, action: 'keep', from: 0, to: 0, pBest: pb, reason: 'Stays paused.' }); continue; }
    keep.push(a);
  }

  // allocate: learning arms get a floor, the rest follows the odds
  const learners = keep.filter(learning);
  const floorTotal = Math.min(dailyTarget, learners.length * floor * dailyTarget);
  const pool = dailyTarget - floorTotal;
  const pSum = keep.reduce((s, a) => s + pBest(a), 0) || 1;
  const want = new Map<string, number>();
  for (const a of keep) want.set(a.id, (learning(a) ? floor * dailyTarget : 0) + pool * (pBest(a) / pSum));

  // platform minimums and the ±step limit; then make it fit the day's budget
  for (const a of keep) {
    let v = want.get(a.id)!;
    if (a.dailyBudget > 0) v = Math.min(a.dailyBudget * (1 + step), Math.max(a.dailyBudget * (1 - step), v));
    want.set(a.id, Math.max(a.minDaily, Math.round(v)));
  }
  let total = [...want.values()].reduce((s, v) => s + v, 0);
  if (total > dailyTarget) {
    // trim arms above their minimum, worst odds first
    for (const a of [...keep].sort((x, y) => pBest(x) - pBest(y))) {
      if (total <= dailyTarget) break;
      const v = want.get(a.id)!, cut = Math.min(v - a.minDaily, total - dailyTarget);
      want.set(a.id, v - cut); total -= cut;
    }
    // still over: the minimums alone don't fit, so drop the weakest arm entirely
    for (const a of [...keep].sort((x, y) => pBest(x) - pBest(y))) {
      if (total <= dailyTarget || keep.filter((k) => want.get(k.id)! > 0).length <= 1) break;
      total -= want.get(a.id)!; want.set(a.id, 0);
    }
  }

  for (const a of keep) {
    const to = want.get(a.id)!, pb = pBest(a);
    const cps = a.sales ? a.spend / a.sales : 0;
    const facts = a.clicks ? `${a.sales} sale${a.sales === 1 ? '' : 's'} from ${a.clicks} clicks${a.sales ? `, ${money(cps)} per sale` : ''}` : 'no clicks yet';
    let action: Decision['action'] = to > a.dailyBudget * 1.02 ? 'raise' : to < a.dailyBudget * 0.98 ? 'lower' : 'keep';
    if (to === 0) action = 'pause';
    if (!a.active && to > 0 && a.spend === 0) action = 'resume';
    const why = to === 0 ? `Paused for now: the daily cap can't cover every platform's minimum, and this one has the weakest odds (${Math.round(pb * 100)}%).`
      : learning(a) ? `Still learning (${money(a.spend)} spent, ${facts}). Kept at ${money(to)}/day so it gets a fair test.`
      : `${facts}; ${Math.round(pb * 100)}% chance it's the best place for this beat.`;
    decisions.push({ armId: a.id, platform: a.platform, action, from: a.dailyBudget, to, pBest: pb, reason: action === 'keep' || action === 'resume' || to === 0 ? why : `${action === 'raise' ? 'Raised' : 'Lowered'} ${money(a.dailyBudget)} → ${money(to)}/day: ${why}` });
  }
  const leader = [...keep].sort((x, y) => pBest(y) - pBest(x))[0];
  const sales = arms.reduce((s, a) => s + a.sales, 0), spent = arms.reduce((s, a) => s + a.spend, 0);
  return {
    decisions, dailyTarget, stopAll: false,
    summary: `${money(spent)} spent, ${sales} sale${sales === 1 ? '' : 's'}${sales ? ` (${money(spent / sales)} each)` : ''}. ${leader ? `${cap(leader.platform)} leads with ${Math.round(pBest(leader) * 100)}% odds.` : ''} Today's budget: ${money(dailyTarget)} of a ${money(p.dailyCap)} cap, ${money(Math.max(0, remaining))} left overall.`,
  };
}

const cap = (p: PlatformId) => ({ meta: 'Meta', tiktok: 'TikTok', google: 'YouTube' }[p]);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r: () => number) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
/** Gamma(k, 1) via Marsaglia–Tsang; Beta(a, b) = X / (X + Y). */
function gamma(r: () => number, k: number): number {
  if (k < 1) return gamma(r, k + 1) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = gauss(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function beta(r: () => number, a: number, b: number) { const x = gamma(r, a); return x / (x + gamma(r, b)); }
