import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimize, type Arm } from '../src/optimizer.js';

// three platforms with hidden truths: TikTok sells best, Meta is ok, Google is expensive
const truth = { tiktok: { cpc: 35, cr: 0.03 }, meta: { cpc: 55, cr: 0.02 }, google: { cpc: 90, cr: 0.006 } } as const;
const lease = 2999;

function simulate(days: number, dailyCap: number, totalCap: number) {
  let seed = 11;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const arms: Arm[] = (['tiktok', 'meta', 'google'] as const).map((p) => ({ id: p, platform: p, active: true, dailyBudget: Math.round(dailyCap / 3), minDaily: p === 'tiktok' ? 2000 : p === 'google' ? 500 : 100, spend: 0, clicks: 0, impressions: 0, sales: 0, revenue: 0 }));
  let spent = 0;
  const history: { day: number; budgets: Record<string, number>; total: number }[] = [];
  for (let day = 0; day < days; day++) {
    const plan = optimize(arms, { dailyCap, totalCap, totalSpent: spent, daysLeft: days - day, avgOrder: lease, seed: day + 1 });
    for (const d of plan.decisions) {
      const a = arms.find((x) => x.id === d.armId)!;
      const prev = a.dailyBudget;
      if (d.action === 'pause') a.active = false;
      else if (d.to > 0) { a.active = true; a.dailyBudget = d.to; }
      if (prev > 0 && d.to > 0 && a.dailyBudget > a.minDaily) assert.ok(d.to <= prev * 1.3 + 1 && d.to >= Math.min(prev * 0.7 - 1, a.minDaily), `${a.id} day ${day}: ${prev} → ${d.to} breaks the 30% step`);
    }
    const dayTotal = arms.filter((a) => a.active).reduce((s, a) => s + a.dailyBudget, 0);
    assert.ok(dayTotal <= dailyCap + 1 || plan.stopAll, `day ${day}: ${dayTotal} over the ${dailyCap} daily cap`);
    assert.ok(dayTotal <= totalCap - spent + 1, `day ${day}: budgets ${dayTotal} exceed the ${totalCap - spent} left`);
    history.push({ day, budgets: Object.fromEntries(arms.map((a) => [a.id, a.active ? a.dailyBudget : 0])), total: dayTotal });
    // the platforms spend the day's budget (never past the total cap)
    for (const a of arms.filter((x) => x.active)) {
      const budget = Math.min(a.dailyBudget, totalCap - spent);
      if (budget <= 0) continue;
      const t = truth[a.platform];
      const clicks = Math.floor(budget / t.cpc);
      let sales = 0;
      for (let i = 0; i < clicks; i++) if (r() < t.cr) sales++;
      a.spend += clicks * t.cpc; a.clicks += clicks; a.sales += sales; a.revenue += sales * lease; spent += clicks * t.cpc;
    }
  }
  return { arms, history, spent };
}

test('budget moves to the platform that actually sells licenses', () => {
  const { history, arms } = simulate(14, 9000, 9000 * 14);
  const last = history.at(-1)!.budgets;
  assert.ok(last.tiktok > last.meta && last.tiktok > (last.google ?? 0), `final budgets ${JSON.stringify(last)}`);
  assert.ok(last.google === 0 || last.google <= 600, 'the expensive, low-converting platform ends near its minimum or paused');
  assert.ok(arms.find((a) => a.id === 'tiktok')!.sales > 0);
});

test('a total smaller than daily cap × days is paced across the run, never exceeded, then everything stops', () => {
  const totalCap = 30000;
  const { spent, history, arms } = simulate(10, 9000, totalCap);
  assert.ok(spent <= totalCap, `spent ${spent} of ${totalCap}`);
  assert.ok(spent >= totalCap * 0.85, `paced to use the budget: spent ${spent}`);
  assert.ok(history.every((h) => h.total <= 3500), 'about $30/day, not $90/day then nothing');
  const after = optimize(arms.map((a) => ({ ...a })), { dailyCap: 9000, totalCap, totalSpent: totalCap, daysLeft: 1, avgOrder: lease });
  assert.equal(after.stopAll, true);
  assert.ok(after.decisions.filter((d) => d.action === 'pause').length >= 1);
});

test('a tiny daily cap that can’t cover every minimum drops the weakest platform', () => {
  const arms: Arm[] = [
    { id: 't', platform: 'tiktok', active: true, dailyBudget: 2000, minDaily: 2000, spend: 5000, clicks: 150, impressions: 9000, sales: 4, revenue: 4 * lease },
    { id: 'g', platform: 'google', active: true, dailyBudget: 500, minDaily: 500, spend: 5000, clicks: 50, impressions: 9000, sales: 0, revenue: 0 },
  ];
  const plan = optimize(arms, { dailyCap: 2200, totalCap: 100000, totalSpent: 10000, daysLeft: 10, avgOrder: lease });
  const g = plan.decisions.find((d) => d.armId === 'g')!;
  assert.equal(g.to, 0);
  assert.match(g.reason, /no sales|weakest/);
  assert.ok(plan.decisions.every((d) => d.reason.length > 10), 'every decision explains itself');
});
