import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().slice(-800)}`))));
  });
}

const hex = (c: string) => '0x' + c.replace('#', '');
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart'];

export interface VisualizerOpts {
  audio: string;
  frame: string;            // background image at the output size
  out: string;
  width: number; height: number;
  color: string; color2?: string;
  start?: number;           // seconds into the track (Shorts start at the drop)
  duration?: number;
}

/** Still artwork + a live waveform drawn from the beat. */
export async function renderVisualizer(o: VisualizerOpts): Promise<string> {
  const wide = o.width > o.height;
  const waveH = Math.round(o.height * (wide ? 0.16 : 0.12));
  const waveY = wide ? Math.round(o.height * 0.79) : Math.round(o.height * 0.74);
  const audioIn = [...(o.start ? ['-ss', String(o.start)] : []), ...(o.duration ? ['-t', String(o.duration)] : []), '-i', o.audio];
  const colors = o.color2 ? `${hex(o.color)}|${hex(o.color2)}` : hex(o.color);
  await ffmpeg([
    '-loop', '1', '-framerate', '30', '-i', o.frame, ...audioIn,
    '-filter_complex',
    `[1:a]aformat=channel_layouts=stereo,showwaves=s=${o.width}x${waveH}:mode=cline:rate=30:split_channels=0:colors=${colors}:scale=sqrt:draw=full,format=rgba[w];` +
    `[0:v]scale=${o.width}:${o.height},format=rgba[b];[b][w]overlay=0:${waveY}:shortest=1,format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', ...ENC, '-shortest', o.out,
  ]);
  return o.out;
}

export interface CinematicOpts {
  clips: string[];          // Higgsfield clips (local files)
  audio: string;
  out: string;
  width: number; height: number;
  cutSeconds: number;       // one or two bars, from the DNA
  beatOffset: number;       // first downbeat, so cuts land on the bar line
  start?: number;
  duration: number;
  color: string;
}

/** Cuts Higgsfield clips on the bar line, loops them under the full beat, and adds a slim waveform. */
export async function assembleCinematic(o: CinematicOpts): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karta-'));
  try {
    const norm: string[] = [];
    for (const [i, c] of o.clips.entries()) {
      const f = join(dir, `n${i}.mp4`);
      await ffmpeg(['-i', c, '-an', '-vf', `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height},fps=30,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', f]);
      norm.push(f);
    }
    // first segment runs to the first downbeat so every later cut lands on a bar line
    const segs: { file: string; len: number }[] = [];
    let t = 0, i = 0;
    const lead = o.start ? 0 : o.beatOffset;
    if (lead > 0.05) { segs.push({ file: norm[0], len: lead }); t = lead; }
    while (t < o.duration) {
      const len = Math.min(o.cutSeconds, o.duration - t);
      segs.push({ file: norm[i++ % norm.length], len });
      t += len;
    }
    const list = segs.map((s) => `file '${s.file}'\ninpoint 0\noutpoint ${s.len.toFixed(3)}`).join('\n');
    const listFile = join(dir, 'list.txt');
    await writeFile(listFile, list);
    const waveH = Math.round(o.height * 0.08);
    await ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      ...(o.start ? ['-ss', String(o.start)] : []), '-t', String(o.duration), '-i', o.audio,
      '-filter_complex',
      `[1:a]aformat=channel_layouts=stereo,showwaves=s=${o.width}x${waveH}:mode=cline:rate=30:colors=${hex(o.color)}:scale=sqrt:draw=full,format=rgba,colorchannelmixer=aa=0.8[w];` +
      `[0:v]format=rgba[b];[b][w]overlay=0:${o.height - waveH - Math.round(o.height * 0.03)}:shortest=1,format=yuv420p[v]`,
      '-map', '[v]', '-map', '1:a', ...ENC, '-shortest', o.out,
    ]);
    return o.out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
