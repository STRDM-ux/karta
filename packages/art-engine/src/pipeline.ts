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

/** Progress events, for live previews (Karta Live in FL Studio, the web editor). */
export type EngineEvent =
  | { type: 'stage'; stage: 'analyzing' | 'designing' | 'cover' | 'visualizer' | 'higgsfield' | 'assembling' | 'publishing' | 'done'; message: string }
  | { type: 'features'; features: AudioFeatures }
  | { type: 'dna'; dna: VisualDNA }
  | { type: 'art'; art: RenderedArt }
  | { type: 'prompts'; still: string; shots: Shot[] }
  | { type: 'shot'; index: number; aspect: '16:9' | '9:16'; status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled' | 'downloaded'; file?: string; error?: string }
  | { type: 'video'; kind: 'wide' | 'tall' | 'cinematicWide' | 'cinematicTall'; file: string }
  | { type: 'error'; message: string };

export interface PipelineOptions {
  audio: string;
  meta: BeatMeta & { bpmHint?: number; keyHint?: string };
  outDir: string;
  video?: boolean;              // render visualizer videos (default true)
  shortSeconds?: number;        // length of the 9:16 cut (default 30)
  higgsfield?: { client?: Higgsfield; uploader: Uploader; maxShots?: number; still?: boolean };
  publish?: { platforms: Platform[]; credentials: Credentials; privacy?: 'public' | 'private' | 'unlisted'; uploader?: Uploader; storeUrl?: string; priceFrom?: string };
  log?: (msg: string) => void;
  onEvent?: (e: EngineEvent) => void;
  /** Higgsfield status polling interval (default 5 s). */
  pollMs?: number;
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
  const emit = (e: EngineEvent) => { try { o.onEvent?.(e); } catch { /* a listener must never break the render */ } };
  const log = (m: string) => { o.log?.(m); };
  const stage = (s: Extract<EngineEvent, { type: 'stage' }>['stage'], message: string) => { log(message); emit({ type: 'stage', stage: s, message }); };
  await mkdir(o.outDir, { recursive: true });

  stage('analyzing', 'Analyzing the beat');
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
  emit({ type: 'features', features });

  stage('designing', 'Turning the sound into a visual DNA');
  const dna = buildDNA(features, o.meta);
  log(`Visual DNA: ${dna.pattern} pattern, ${dna.mood.join(', ')}, ${dna.motion.pace} motion`);
  emit({ type: 'dna', dna });

  stage('cover', 'Rendering cover art, thumbnail and video frames');
  const art = await renderArt(features, dna, o.outDir);
  emit({ type: 'art', art });

  const prompts = { still: stillPrompt(dna), shots: shotList(features, dna, o.higgsfield?.maxShots ?? 4) };
  emit({ type: 'prompts', ...prompts });
  const videos: PipelineResult['videos'] = {};
  const shortLen = Math.min(o.shortSeconds ?? 30, Math.max(5, features.duration - features.drop));
  const shortStart = Math.max(0, Math.min(features.drop, features.duration - shortLen));

  if (o.video !== false) {
    stage('visualizer', 'Rendering visualizer videos (16:9 full beat, 9:16 from the drop)');
    videos.wide = await renderVisualizer({ audio: o.audio, frame: art.frameWide, out: join(o.outDir, 'youtube.mp4'), width: 1920, height: 1080, color: dna.palette.primary, color2: dna.palette.accent });
    emit({ type: 'video', kind: 'wide', file: videos.wide });
    videos.tall = await renderVisualizer({ audio: o.audio, frame: art.frameTall, out: join(o.outDir, 'short.mp4'), width: 1080, height: 1920, color: dna.palette.primary, start: shortStart, duration: shortLen });
    emit({ type: 'video', kind: 'tall', file: videos.tall });
  }

  if (o.higgsfield) {
    const hf = o.higgsfield.client ?? new Higgsfield();
    stage('higgsfield', 'Sending the cover to Higgsfield as the reference image');
    const coverUrl = await o.higgsfield.uploader(art.coverClean, 'image/jpeg');
    if (o.higgsfield.still) {
      log('Higgsfield: cinematic still');
      videos.higgsfieldStill = await download(await hf.image(prompts.still), join(o.outDir, 'higgsfield-still.jpg'));
    }
    const wideClips: string[] = [], tallClips: string[] = [];
    const one = async (i: number, shot: Shot, aspect: '16:9' | '9:16') => {
      try {
        const url = await hf.referenceToVideo({
          imageUrls: [coverUrl], prompt: shot.prompt, aspect, duration: shot.duration, intervalMs: o.pollMs,
          onStatus: (status) => emit({ type: 'shot', index: i, aspect, status }),
        });
        const file = await download(url, join(o.outDir, `hf-${i}-${aspect === '16:9' ? 'wide' : 'tall'}.mp4`));
        emit({ type: 'shot', index: i, aspect, status: 'downloaded', file });
        return file;
      } catch (e) {
        emit({ type: 'shot', index: i, aspect, status: 'failed', error: (e as Error).message });
        throw e;
      }
    };
    for (const [i, shot] of prompts.shots.entries()) {
      log(`Higgsfield: ${shot.section} shot (${shot.duration}s), 16:9 and 9:16`);
      const [w, t] = await Promise.all([one(i, shot, '16:9'), one(i, shot, '9:16')]);
      wideClips.push(w);
      tallClips.push(t);
    }
    stage('assembling', 'Cutting Higgsfield clips to the bar line under the beat');
    videos.cinematicWide = await assembleCinematic({ clips: wideClips, audio: o.audio, out: join(o.outDir, 'youtube-cinematic.mp4'), width: 1920, height: 1080, cutSeconds: dna.motion.cutSeconds, beatOffset: features.beatOffset, duration: features.duration, color: dna.palette.accent });
    emit({ type: 'video', kind: 'cinematicWide', file: videos.cinematicWide });
    videos.cinematicTall = await assembleCinematic({ clips: tallClips, audio: o.audio, out: join(o.outDir, 'short-cinematic.mp4'), width: 1080, height: 1920, cutSeconds: dna.motion.cutSeconds, beatOffset: features.beatOffset, start: shortStart, duration: shortLen, color: dna.palette.accent });
    emit({ type: 'video', kind: 'cinematicTall', file: videos.cinematicTall });
  }

  const copy = buildCopy(dna, { storeUrl: o.publish?.storeUrl, priceFrom: o.publish?.priceFrom, tags: o.meta.tags });
  let published: PublishResult[] = [];
  if (o.publish?.platforms.length) {
    const wide = videos.cinematicWide ?? videos.wide, tall = videos.cinematicTall ?? videos.tall;
    if (!wide || !tall) throw new Error('Publishing needs videos; run without --no-video.');
    const tallUrl = o.publish.platforms.includes('instagram') && o.publish.uploader ? await o.publish.uploader(tall, 'video/mp4') : undefined;
    stage('publishing', `Publishing to ${o.publish.platforms.join(', ')}`);
    published = await publish(o.publish.platforms, { wide, tall, thumbnail: art.thumbnail, tallUrl }, copy, o.publish.credentials, o.publish.privacy);
  }

  const manifest = join(o.outDir, 'karta.json');
  await writeFile(manifest, JSON.stringify({ meta: o.meta, features, dna, art, prompts, videos, copy, published }, null, 2));
  stage('done', 'Done');
  return { features, dna, art, prompts, videos, copy, published, manifest };
}
