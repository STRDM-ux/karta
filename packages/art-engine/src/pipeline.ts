import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { analyzeFile, type AudioFeatures } from './audio/analyze.js';
import { buildDNA, type BeatMeta, type VisualDNA } from './dna.js';
import { renderArt, type RenderedArt } from './art/cover.js';
import { renderVisualizer, assembleCinematic } from './video/render.js';
import { Higgsfield, download } from './higgsfield/client.js';
import { shotList, stillPrompt, type Shot } from './higgsfield/prompts.js';
import { buildCopy, publish, type Copy, type Credentials, type Platform, type PublishResult } from './publish/index.js';

/** Makes a local file reachable at a public URL (Higgsfield and Instagram fetch media by URL). */
export type Uploader = (file: string, contentType: string) => Promise<string>;

/** Copies files into a folder that is already served publicly (a mounted bucket, a CDN folder). */
export const folderUploader = (dir: string, baseUrl: string): Uploader => async (file) => {
  const name = `${Date.now().toString(36)}-${basename(file)}`;
  await copyFile(file, join(dir, name));
  return `${baseUrl.replace(/\/$/, '')}/${name}`;
};

export interface PipelineOptions {
  audio: string;
  meta: BeatMeta & { bpmHint?: number; keyHint?: string };
  outDir: string;
  video?: boolean;              // render visualizer videos (default true)
  shortSeconds?: number;        // length of the 9:16 cut (default 30)
  higgsfield?: { client?: Higgsfield; uploader: Uploader; maxShots?: number; still?: boolean };
  publish?: { platforms: Platform[]; credentials: Credentials; privacy?: 'public' | 'private' | 'unlisted'; uploader?: Uploader; storeUrl?: string; priceFrom?: string };
  log?: (msg: string) => void;
}

export interface PipelineResult {
  features: AudioFeatures;
  dna: VisualDNA;
  art: RenderedArt;
  prompts: { still: string; shots: Shot[] };
  videos: { wide?: string; tall?: string; cinematicWide?: string; cinematicTall?: string; higgsfieldStill?: string };
  copy: Copy;
  published: PublishResult[];
  manifest: string;
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const log = o.log ?? (() => {});
  await mkdir(o.outDir, { recursive: true });

  log('Analyzing the beat');
  const features = await analyzeFile(o.audio, { genre: o.meta.genre, bpmHint: o.meta.bpmHint });
  // the key the producer typed in wins over detection
  const k = o.meta.keyHint?.trim().match(/^([A-G])([#b]?)(m|min|minor)?$/i);
  if (k) {
    const names: Record<string, string> = { 'C#': 'C#', Db: 'C#', 'D#': 'Eb', Eb: 'Eb', 'F#': 'F#', Gb: 'F#', 'G#': 'Ab', Ab: 'Ab', 'A#': 'Bb', Bb: 'Bb' };
    const raw = k[1].toUpperCase() + (k[2] ?? '');
    const tonic = (names[raw] ?? raw) as AudioFeatures['key']['tonic'];
    const mode = k[3] ? 'minor' : 'major';
    features.key = { tonic, mode, label: tonic + (mode === 'minor' ? 'm' : ''), confidence: 1 };
  }
  log(`  ${features.bpm} BPM · ${features.key.label} · energy ${features.energy} · drop at ${features.drop}s`);

  const dna = buildDNA(features, o.meta);
  log(`Visual DNA: ${dna.pattern} pattern, ${dna.mood.join(', ')}, ${dna.motion.pace} motion`);

  log('Rendering cover art, thumbnail and video frames');
  const art = await renderArt(features, dna, o.outDir);

  const prompts = { still: stillPrompt(dna), shots: shotList(features, dna, o.higgsfield?.maxShots ?? 4) };
  const videos: PipelineResult['videos'] = {};
  const shortLen = Math.min(o.shortSeconds ?? 30, Math.max(5, features.duration - features.drop));
  const shortStart = Math.max(0, Math.min(features.drop, features.duration - shortLen));

  if (o.video !== false) {
    log('Rendering visualizer videos (16:9 full beat, 9:16 from the drop)');
    videos.wide = await renderVisualizer({ audio: o.audio, frame: art.frameWide, out: join(o.outDir, 'youtube.mp4'), width: 1920, height: 1080, color: dna.palette.primary, color2: dna.palette.accent });
    videos.tall = await renderVisualizer({ audio: o.audio, frame: art.frameTall, out: join(o.outDir, 'short.mp4'), width: 1080, height: 1920, color: dna.palette.primary, start: shortStart, duration: shortLen });
  }

  if (o.higgsfield) {
    const hf = o.higgsfield.client ?? new Higgsfield();
    log('Uploading the clean cover so Higgsfield can use it as the reference');
    const coverUrl = await o.higgsfield.uploader(art.coverClean, 'image/jpeg');
    if (o.higgsfield.still) {
      log('Higgsfield: cinematic still');
      videos.higgsfieldStill = await download(await hf.image(prompts.still), join(o.outDir, 'higgsfield-still.jpg'));
    }
    const wideClips: string[] = [], tallClips: string[] = [];
    for (const [i, shot] of prompts.shots.entries()) {
      log(`Higgsfield: ${shot.section} shot (${shot.duration}s), 16:9 and 9:16`);
      const [w, t] = await Promise.all([
        hf.referenceToVideo({ imageUrls: [coverUrl], prompt: shot.prompt, aspect: '16:9', duration: shot.duration }),
        hf.referenceToVideo({ imageUrls: [coverUrl], prompt: shot.prompt, aspect: '9:16', duration: shot.duration }),
      ]);
      wideClips.push(await download(w, join(o.outDir, `hf-${i}-wide.mp4`)));
      tallClips.push(await download(t, join(o.outDir, `hf-${i}-tall.mp4`)));
    }
    log('Cutting Higgsfield clips to the bar line under the beat');
    videos.cinematicWide = await assembleCinematic({ clips: wideClips, audio: o.audio, out: join(o.outDir, 'youtube-cinematic.mp4'), width: 1920, height: 1080, cutSeconds: dna.motion.cutSeconds, beatOffset: features.beatOffset, duration: features.duration, color: dna.palette.accent });
    videos.cinematicTall = await assembleCinematic({ clips: tallClips, audio: o.audio, out: join(o.outDir, 'short-cinematic.mp4'), width: 1080, height: 1920, cutSeconds: dna.motion.cutSeconds, beatOffset: features.beatOffset, start: shortStart, duration: shortLen, color: dna.palette.accent });
  }

  const copy = buildCopy(dna, { storeUrl: o.publish?.storeUrl, priceFrom: o.publish?.priceFrom, tags: o.meta.tags });
  let published: PublishResult[] = [];
  if (o.publish?.platforms.length) {
    const wide = videos.cinematicWide ?? videos.wide, tall = videos.cinematicTall ?? videos.tall;
    if (!wide || !tall) throw new Error('Publishing needs videos; run without --no-video.');
    const tallUrl = o.publish.platforms.includes('instagram') && o.publish.uploader ? await o.publish.uploader(tall, 'video/mp4') : undefined;
    log(`Publishing to ${o.publish.platforms.join(', ')}`);
    published = await publish(o.publish.platforms, { wide, tall, thumbnail: art.thumbnail, tallUrl }, copy, o.publish.credentials, o.publish.privacy);
  }

  const manifest = join(o.outDir, 'karta.json');
  await writeFile(manifest, JSON.stringify({ meta: o.meta, features, dna, art, prompts, videos, copy, published }, null, 2));
  return { features, dna, art, prompts, videos, copy, published, manifest };
}
