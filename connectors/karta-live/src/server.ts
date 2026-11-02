// Karta Live: a small local server that renders a beat with the Karta art engine + Higgsfield and
// streams every step to a preview window that plays the visuals in time with FL Studio.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { runPipeline, Higgsfield, type EngineEvent, type Uploader } from '@karta/art-engine';
import { FLBridge, type FLState } from './fl.js';

export interface LiveConfig {
  port: number;
  home: string;                 // ~/Karta Live: renders, drop folder, config
  higgsfield?: { keyId: string; keySecret: string; base?: string };
  karta?: { api: string; token: string }; // hosts the cover at a public URL for Higgsfield
  maxShots: number;
  pollMs?: number;
}

type Job = {
  id: string; title: string; status: 'running' | 'done' | 'failed'; startedAt: number;
  audio: string; dir: string; events: EngineEvent[]; error?: string;
};

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json', '.svg': 'image/svg+xml' };
const AUDIO = new Set(['.wav', '.mp3', '.flac', '.aif', '.aiff', '.m4a', '.ogg']);
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, '..', 'public');

export function loadConfig(): LiveConfig {
  const home = process.env.KARTA_LIVE_HOME ?? join(homedir(), 'Karta Live');
  mkdirSync(join(home, 'Drop'), { recursive: true });
  mkdirSync(join(home, 'renders'), { recursive: true });
  let file: Partial<{ higgsfieldKeyId: string; higgsfieldKeySecret: string; kartaApi: string; kartaToken: string; maxShots: number }> = {};
  try { file = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')); } catch { /* first run */ }
  const keyId = process.env.HF_API_KEY_ID ?? file.higgsfieldKeyId, keySecret = process.env.HF_API_KEY_SECRET ?? file.higgsfieldKeySecret;
  const kartaApi = process.env.KARTA_API_URL ?? file.kartaApi, kartaToken = process.env.KARTA_TOKEN ?? file.kartaToken;
  return {
    port: Number(process.env.KARTA_LIVE_PORT ?? 4747), home,
    higgsfield: keyId && keySecret ? { keyId, keySecret, base: process.env.HF_API_BASE } : undefined,
    karta: kartaApi && kartaToken ? { api: kartaApi.replace(/\/$/, ''), token: kartaToken } : undefined,
    maxShots: Number(process.env.KARTA_LIVE_SHOTS ?? file.maxShots ?? 4),
    pollMs: process.env.KARTA_LIVE_POLL_MS ? Number(process.env.KARTA_LIVE_POLL_MS) : undefined,
  };
}

/** Puts a file on Karta so Higgsfield can fetch it by URL. */
export const kartaUploader = (api: string, token: string): Uploader => async (file, contentType) => {
  const res = await fetch(`${api}/studio/live/${encodeURIComponent(basename(file))}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType }, body: await readFile(file) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { url: string }; error?: string };
  if (!res.ok || !j.data?.url) throw new Error(`Couldn't host the cover on Karta: ${j.error ?? res.status}`);
  return j.data.url;
};

export function startServer(cfg: LiveConfig, fl = new FLBridge()) {
  const jobs = new Map<string, Job>();
  let current: Job | null = null;
  const clients = new Set<ServerResponse>();

  const sse = (event: string, data: unknown, to: Iterable<ServerResponse> = clients) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of to) c.write(msg);
  };
  const fileUrl = (job: Job, file?: string) => (file ? `/files/${job.id}/${relative(job.dir, file).split(sep).join('/')}` : undefined);

  /** Engine events carry local paths; the window gets URLs it can load. */
  const forClient = (job: Job, e: EngineEvent): Record<string, unknown> => {
    if (e.type === 'art') return { ...e, art: Object.fromEntries(Object.entries(e.art).map(([k, v]) => [k, fileUrl(job, v)])) };
    if (e.type === 'shot' || e.type === 'video') return { ...e, file: fileUrl(job, e.file) };
    return e;
  };
  const snapshot = () => ({
    fl: { connected: fl.connected, installed: fl.installed, dir: fl.dir, state: fl.state },
    setup: { higgsfield: !!cfg.higgsfield, karta: !!cfg.karta, dropFolder: join(cfg.home, 'Drop') },
    job: current && { id: current.id, title: current.title, status: current.status, error: current.error, audio: `/files/${current.id}/${basename(current.audio)}`, events: current.events.map((e) => forClient(current!, e)) },
  });

  fl.on((state, connected) => sse('fl', { connected, state }));

  const hint = (text: string) => { if (fl.connected) { try { fl.send({ type: 'hint', text: `Karta: ${text}` }); } catch { /* FL folder not writable */ } } };

  async function render(audio: string, meta: { title: string; producer?: string; genre?: string; bpm?: number; key?: string; pattern?: 'rings' | 'flow' | 'skyline' }) {
    if (current?.status === 'running') throw new Error('A render is already running. Wait for it to finish.');
    const id = Date.now().toString(36) + randomUUID().slice(0, 4);
    const dir = join(cfg.home, 'renders', id);
    mkdirSync(dir, { recursive: true });
    const job: Job = { id, title: meta.title, status: 'running', startedAt: Date.now(), audio, dir, events: [] };
    jobs.set(id, job);
    current = job;
    sse('job', snapshot().job);
    const higgs = cfg.higgsfield && cfg.karta
      ? { client: new Higgsfield(cfg.higgsfield.keyId, cfg.higgsfield.keySecret, cfg.higgsfield.base), uploader: kartaUploader(cfg.karta.api, cfg.karta.token), maxShots: cfg.maxShots }
      : undefined;
    hint(`rendering visuals for ${meta.title}`);
    try {
      await runPipeline({
        audio, outDir: dir, pollMs: cfg.pollMs,
        meta: { title: meta.title, producer: meta.producer ?? 'Producer', genre: meta.genre, pattern: meta.pattern, bpmHint: meta.bpm, keyHint: meta.key },
        higgsfield: higgs,
        onEvent: (e) => {
          job.events.push(e);
          sse('engine', forClient(job, e));
          if (e.type === 'shot' && e.status === 'downloaded' && e.aspect === '16:9') hint(`shot ${e.index + 1} is ready`);
          if (e.type === 'art') hint('cover art is ready');
        },
      });
      job.status = 'done';
      hint(higgs ? 'Higgsfield visuals are ready' : 'cover and visualizer are ready');
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
      hint('render failed, see Karta Live');
    }
    sse('job', snapshot().job);
  }

  /** Renders anything FL exports into the Drop folder (File > Export > WAV, pointed at Karta Live/Drop). */
  const drop = join(cfg.home, 'Drop');
  const seen = new Map<string, number>();
  for (const f of readdirSync(drop)) seen.set(f, statSync(join(drop, f)).mtimeMs);
  const settle = new Map<string, NodeJS.Timeout>();
  try {
    watch(drop, (_e, f) => {
      if (!f || !AUDIO.has(extname(f).toLowerCase())) return;
      clearTimeout(settle.get(f));
      // wait until FL has finished writing the export
      settle.set(f, setTimeout(() => {
        const p = join(drop, f);
        if (!existsSync(p)) return;
        const m = statSync(p).mtimeMs;
        if (seen.get(f) === m) return;
        seen.set(f, m);
        const title = fl.state?.title?.replace(/\s*-\s*FL Studio.*$/i, '').replace(/\.flp$/i, '').trim() || basename(f, extname(f));
        void render(p, { title, bpm: fl.state?.tempo ? Math.round(fl.state.tempo) : undefined }).catch(() => undefined);
      }, 1500));
    });
  } catch { /* drop folder watching unavailable */ }

  const body = (req: IncomingMessage, limit = 600 * 1024 * 1024) => new Promise<Buffer>((ok, bad) => {
    const parts: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { bad(new Error('Too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', bad);
  });
  const send = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, snapshot());
      if (req.method === 'POST' && url.pathname === '/fl') {
        const cmd = JSON.parse((await body(req, 10_000)).toString() || '{}');
        if (!['seek', 'play', 'stop', 'toggle', 'hint'].includes(cmd.type)) return send(res, 400, { error: 'Unknown command' });
        if (!fl.connected) return send(res, 409, { error: 'FL Studio isn’t connected. Open FL Studio with the Karta Live script enabled.' });
        fl.send(cmd);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/render') {
        const name = basename(String(req.headers['x-filename'] ?? 'beat.wav')).replace(/[^\w.\- ]+/g, '');
        if (!AUDIO.has(extname(name).toLowerCase())) return send(res, 400, { error: 'Drop a WAV, MP3, FLAC, AIFF or M4A file.' });
        const data = await body(req);
        const inbox = join(cfg.home, 'renders', 'uploads');
        mkdirSync(inbox, { recursive: true });
        const p = join(inbox, `${Date.now().toString(36)}-${name}`);
        writeFileSync(p, data);
        const h = (k: string) => (req.headers[k] ? decodeURIComponent(String(req.headers[k])) : undefined);
        if (current?.status === 'running') return send(res, 409, { error: 'A render is already running. Wait for it to finish.' });
        void render(p, { title: h('x-title') || basename(name, extname(name)), producer: h('x-producer'), genre: h('x-genre'), pattern: h('x-pattern') as 'rings' | 'flow' | 'skyline' | undefined, bpm: h('x-bpm') ? Number(h('x-bpm')) : undefined, key: h('x-key') });
        return send(res, 202, { ok: true });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const [, , id, ...rest] = url.pathname.split('/');
        const job = jobs.get(id);
        if (!job) return send(res, 404, { error: 'Not found' });
        const want = decodeURIComponent(rest.join('/'));
        // the job's own folder, or its source audio
        const p = want === basename(job.audio) ? job.audio : resolve(job.dir, want);
        if (p !== job.audio && !p.startsWith(job.dir + sep)) return send(res, 403, { error: 'Forbidden' });
        return serveFile(req, res, p);
      }
      if (req.method === 'GET') {
        const p = resolve(PUBLIC, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!p.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
        return serveFile(req, res, p);
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });

  fl.start();
  server.listen(cfg.port, '127.0.0.1');
  return { server, fl, render, jobs: () => jobs, close: () => { fl.stop(); server.close(); for (const c of clients) c.end(); } };
}

function serveFile(req: IncomingMessage, res: ServerResponse, p: string) {
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  const size = statSync(p).size;
  const type = MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    createReadStream(p, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  createReadStream(p).pipe(res);
}

export type { FLState };
