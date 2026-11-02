#!/usr/bin/env node
import { resolve } from 'node:path';
import { runPipeline, folderUploader } from './pipeline.js';
import type { Platform } from './publish/index.js';

const HELP = `karta-art: turn a beat into cover art, cinematic visuals and posts

Usage:
  karta-art <audio> --title "Spanish Town Dusk" --producer "Nine Mile Sound" [options]

Options:
  --genre <name>          dancehall, reggae, drill, trap, afrobeats, amapiano… (sets tempo range and scene)
  --bpm <n>               the BPM you made it at (fixes half/double-time detection)
  --key <key>             the key you made it in, e.g. C#m or Bb (overrides detection)
  --tags a,b,c            artist type-beat tags for captions
  --pattern <p>           rings | flow | skyline (default: picked from the audio)
  --brand <#hex>          replace the accent colour, e.g. STRDM pink #ff3d8a
  --out <dir>             output folder (default ./out/<title>)
  --no-video              art only
  --short <seconds>       length of the 9:16 cut from the drop (default 30)
  --higgsfield            generate cinematic clips (needs HF_API_KEY_ID / HF_API_KEY_SECRET and --public-dir/--public-url)
  --shots <n>             Higgsfield shots, one per song section (default 4)
  --public-dir <dir>      folder that is served publicly …
  --public-url <url>      … and the URL it is served at (Higgsfield and Instagram fetch media from it)
  --publish <list>        youtube,youtube_shorts,tiktok,instagram
  --privacy <p>           public | unlisted | private (default private, so you can check first)
  --store <url>           your Karta store link for captions
  --price-from <text>     e.g. "$29.99"

Credentials for --publish come from the environment:
  YOUTUBE_ACCESS_TOKEN, TIKTOK_ACCESS_TOKEN, INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID`;

function parse(argv: string[]) {
  const a: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      if (k.startsWith('no-')) a[k.slice(3)] = false;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
      else a[k] = true;
    } else pos.push(t);
  }
  return { a, pos };
}

async function main() {
  const { a, pos } = parse(process.argv.slice(2));
  if (!pos[0] || a.help || !a.title || !a.producer) { console.log(HELP); process.exit(pos[0] ? 1 : 0); }
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const title = s('title')!;
  const uploader = s('public-dir') && s('public-url') ? folderUploader(resolve(s('public-dir')!), s('public-url')!) : undefined;
  if (a.higgsfield && !uploader) throw new Error('--higgsfield needs --public-dir and --public-url so Higgsfield can read the cover.');

  const res = await runPipeline({
    audio: resolve(pos[0]),
    meta: {
      title, producer: s('producer')!, genre: s('genre'), tags: s('tags')?.split(',').map((x) => x.trim()),
      pattern: s('pattern') as 'rings' | 'flow' | 'skyline' | undefined, brandAccent: s('brand'),
      bpmHint: s('bpm') ? Number(s('bpm')) : undefined, keyHint: s('key'),
    },
    outDir: resolve(s('out') ?? `out/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
    video: a.video !== false,
    shortSeconds: s('short') ? Number(s('short')) : undefined,
    higgsfield: a.higgsfield ? { uploader: uploader!, maxShots: s('shots') ? Number(s('shots')) : 4 } : undefined,
    publish: s('publish') ? {
      platforms: s('publish')!.split(',').map((x) => x.trim()) as Platform[],
      privacy: (s('privacy') as 'public' | 'private' | 'unlisted') ?? 'private',
      uploader, storeUrl: s('store'), priceFrom: s('price-from'),
      credentials: {
        youtubeAccessToken: process.env.YOUTUBE_ACCESS_TOKEN, tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN,
        instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN, instagramUserId: process.env.INSTAGRAM_USER_ID,
      },
    } : undefined,
    log: (m) => console.log(m),
  });

  console.log(`\nDone. Everything is in ${res.manifest.replace(/\/karta\.json$/, '')}`);
  for (const p of res.published) console.log(`  ${p.ok ? '✓' : '✗'} ${p.platform}${p.url ? ' ' + p.url : ''}${p.error ? ' — ' + p.error : ''}${p.note ? ' (' + p.note + ')' : ''}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
