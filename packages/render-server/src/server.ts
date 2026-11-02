// Karta render server: runs the art engine for the web editor's "Artwork from the beat".
// Cloudflare Workers can't run ffmpeg, so this small Node service does (a container, Fly, a VM).
//
//  POST /jobs { jobId, meta, pattern?, api }   Authorization: Bearer RENDER_SECRET
//    → 202, then in the background: fetch the beat from {api}/internal/jobs/:id/audio, render the cover,
//      thumbnail, YouTube visualizer and 9:16 short, upload each to {api}/internal/jobs/:id/files/:kind,
//      and report to {api}/internal/jobs/:id (art keys, or the error).
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { runPipeline } from '@karta/art-engine';

const SECRET = process.env.RENDER_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 8080);
const MAX_PARALLEL = Number(process.env.RENDER_PARALLEL ?? 2);
// only these Karta backends may be called back (stops the secret being sent somewhere else)
const ALLOWED = (process.env.KARTA_API_ORIGINS ?? 'http://localhost:8787,http://127.0.0.1:8787').split(',').map((s) => s.trim().replace(/\/$/, ''));

type Job = { jobId: string; api: string; meta: { title: string; producer?: string; genre?: string; bpm?: number; key?: string; tags?: string[] }; pattern?: 'rings' | 'flow' | 'skyline' };
let running = 0;
const queue: Job[] = [];

const authed = (h: string | undefined) => {
  const want = Buffer.from(`Bearer ${SECRET}`), got = Buffer.from(h ?? '');
  return SECRET.length > 0 && got.length === want.length && timingSafeEqual(got, want);
};

async function call(job: Job, path: string, init: RequestInit = {}) {
  const res = await fetch(`${job.api}/internal/jobs/${job.jobId}${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path || 'report'} → ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res;
}

async function run(job: Job) {
  const dir = await mkdtemp(join(tmpdir(), 'karta-render-'));
  try {
    const audio = await call(job, '/audio');
    const type = audio.headers.get('content-type') ?? '';
    const src = join(dir, `beat.${/wav/.test(type) ? 'wav' : 'mp3'}`);
    await writeFile(src, Buffer.from(await audio.arrayBuffer()));
    const res = await runPipeline({
      audio: src, outDir: join(dir, 'out'),
      meta: { title: job.meta.title, producer: job.meta.producer ?? 'Producer', genre: job.meta.genre, tags: job.meta.tags, pattern: job.pattern, bpmHint: job.meta.bpm, keyHint: job.meta.key },
    });
    const files: [string, string, string][] = [
      ['cover', res.art.cover, 'image/jpeg'], ['thumbnail', res.art.thumbnail, 'image/jpeg'],
      ...(res.videos.wide ? [['youtube', res.videos.wide, 'video/mp4'] as [string, string, string]] : []),
      ...(res.videos.tall ? [['short', res.videos.tall, 'video/mp4'] as [string, string, string]] : []),
    ];
    const art: Record<string, string> = {};
    for (const [kind, file, mime] of files) {
      const r = await call(job, `/files/${kind}`, { method: 'PUT', headers: { 'Content-Type': mime }, body: await readFile(file) });
      art[kind] = ((await r.json()) as { data: { key: string } }).data.key;
    }
    await call(job, '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ art, features: { bpm: res.features.bpm, key: res.features.key.label, drop: res.features.drop } }) });
    console.log(`[render] ${job.jobId} done (${res.features.bpm} BPM, ${res.features.key.label})`);
  } catch (e) {
    console.error(`[render] ${job.jobId} failed:`, e);
    await call(job, '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Rendering failed: ${(e as Error).message}`.slice(0, 280) }) }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    void run(job).finally(() => { running--; pump(); });
  }
}

createServer((req, res) => {
  const reply = (s: number, d: unknown) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, running, queued: queue.length });
  if (req.method !== 'POST' || req.url !== '/jobs') return reply(404, { error: 'Not found' });
  if (!authed(req.headers.authorization)) return reply(401, { error: 'Unauthorized' });
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let job: Job;
    try { job = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400, { error: 'Bad JSON' }); }
    job.api = String(job.api ?? '').replace(/\/$/, '');
    if (!job.jobId || !job.meta?.title || !ALLOWED.includes(job.api)) return reply(400, { error: 'Missing jobId/meta, or api is not an allowed Karta backend' });
    queue.push(job);
    pump();
    reply(202, { ok: true, queued: queue.length });
  });
}).listen(PORT, () => console.log(`Karta render server on :${PORT}`));
