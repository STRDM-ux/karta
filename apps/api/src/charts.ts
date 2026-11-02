// Charts: Apple Music Top Songs by country, ported from STRDM functions/charts.ts.
// The chart as kworb.net shows it (position, movement, artist, title), with cover art and an
// Apple Music link added from Apple's own most-played feed. Cached at the edge for 20 minutes.

import { json } from './util';

const CACHE_SECONDS = 20 * 60;
export const COUNTRIES: Record<string, string> = { jm: 'Jamaica', us: 'United States', gb: 'United Kingdom', ca: 'Canada', tt: 'Trinidad and Tobago', ng: 'Nigeria' };

export type ChartEntry = { pos: number; move: string; artist: string; title: string; artwork: string; url: string };

function decode(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).trim();
}
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Parses kworb's chart table: Pos | P+ | "Artist - Title". */
export function parseKworb(html: string): { updated: string; rows: Omit<ChartEntry, 'artwork' | 'url'>[] } {
  const updated = decode(/<span class="pagetitle">[^|]*\|\s*([^|<]+)/.exec(html)?.[1] ?? '');
  const rows: Omit<ChartEntry, 'artwork' | 'url'>[] = [];
  const re = /<tr><td>(\d+)<\/td><td>([^<]*)<\/td><td class="mp text"><div>([\s\S]*?)<\/div><\/td><\/tr>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const t = decode(m[3]);
    const cut = t.indexOf(' - ');
    rows.push({ pos: Number(m[1]), move: decode(m[2]) || '=', artist: cut > 0 ? t.slice(0, cut) : '', title: cut > 0 ? t.slice(cut + 3) : t });
  }
  return { updated, rows };
}

type AppleSong = { artistName?: string; name?: string; artworkUrl100?: string; url?: string };

export async function buildChart(country: string): Promise<Record<string, unknown>> {
  const [kworb, apple] = await Promise.all([
    fetch(`https://kworb.net/charts/apple_s/${country}.html`, { headers: { 'User-Agent': 'Karta charts (strdm.io)' } }),
    fetch(`https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/songs.json`).catch(() => null),
  ]);
  if (!kworb.ok) throw new Error(`kworb ${kworb.status}`);
  const { updated, rows } = parseKworb(await kworb.text());
  if (!rows.length) throw new Error('kworb table not found');
  const songs = apple?.ok ? (((await apple.json().catch(() => null)) as { feed?: { results?: AppleSong[] } } | null)?.feed?.results ?? []) : [];
  const byBoth = new Map<string, AppleSong>(), byTitle = new Map<string, AppleSong>();
  for (const s of songs) {
    byBoth.set(norm(`${s.artistName ?? ''}${s.name ?? ''}`), s);
    if (!byTitle.has(norm(s.name ?? ''))) byTitle.set(norm(s.name ?? ''), s);
  }
  const items: ChartEntry[] = rows.map((r) => {
    const hit = byBoth.get(norm(`${r.artist}${r.title}`)) ?? byTitle.get(norm(r.title));
    return { ...r, artwork: hit?.artworkUrl100 ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x300bb.') : '', url: hit?.url ?? '' };
  });
  return {
    ok: true, country, title: `${COUNTRIES[country] ?? country.toUpperCase()} Apple Music Top Songs`, updated,
    source: { name: 'kworb.net', url: `https://kworb.net/charts/apple_s/${country}.html` }, fetchedAt: Date.now(), items,
  };
}

export async function handleCharts(url: URL, ctx: ExecutionContext): Promise<Response> {
  const country = (url.searchParams.get('country') ?? 'jm').toLowerCase();
  if (!COUNTRIES[country]) return json({ ok: false, error: 'Unknown chart' }, 400);
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://karta.internal/charts/apple/${country}`);
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return json(await hit.json(), 200, { 'Cache-Control': 'public, max-age=300' });
  try {
    const data = await buildChart(country);
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } })).catch(() => undefined));
    return json(data, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (e) {
    console.error('[charts] build failed:', e);
    return json({ ok: false, error: 'The chart is unavailable right now. Try again in a minute.' }, 502);
  }
}
