// End to end: simulated FL Studio (the real script) ⇄ Karta Live ⇄ mock Higgsfield + Karta upload.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMocks } from './mock-services.mjs';
import { installScript, FLBridge } from '../src/fl.js';
import { startServer, type LiveConfig } from '../src/server.js';

const root = mkdtempSync(join(tmpdir(), 'karta-live-'));
const scriptDir = join(root, 'Documents', 'Image-Line', 'FL Studio', 'Settings', 'Hardware', 'Karta Live');
const PORT = 4799;
let mocks: ReturnType<typeof startMocks>;
let live: ReturnType<typeof startServer>;
let fl: ChildProcess;
const events: { event: string; data: any }[] = [];

function wav(path: string) {
  // 30 s, 96 BPM: 8 quiet bars then kick + bass, so the drop lands at 20 s
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=92.5:d=30', '-f', 'lavfi', '-i', 'aevalsrc=if(gte(t\\,20)\\,0.9*sin(2*PI*55*t)*exp(-mod(t\\,0.625)*14)\\,0):d=30',
    '-filter_complex', '[0]volume=0.15[a];[a][1]amix=inputs=2:normalize=0', '-ar', '22050', path]);
}

before(async () => {
  mocks = startMocks(8791, { pollsPerStage: 1 });
  installScript(scriptDir);
  fl = spawn('python3', [join(import.meta.dirname, 'fake_fl.py'), scriptDir, '120', '96'], { stdio: 'inherit' });
  const cfg: LiveConfig = {
    port: PORT, home: join(root, 'Karta Live'), maxShots: 2, pollMs: 150,
    higgsfield: { keyId: 'test-id', keySecret: 'test-secret', base: 'http://127.0.0.1:8791' },
    karta: { api: 'http://127.0.0.1:8791', token: 'karta-test-token' },
  };
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cfg.home, 'Drop'), { recursive: true });
  mkdirSync(join(cfg.home, 'renders'), { recursive: true });
  live = startServer(cfg, new FLBridge(scriptDir));
  // listen to the same event stream the preview window uses
  const res = await fetch(`http://127.0.0.1:${PORT}/events`);
  const reader = res.body!.getReader();
  let buf = '';
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(chunk)?.[1], data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  })();
});

after(() => { fl?.kill(); live?.close(); mocks?.close(); });

const waitFor = async <T>(fn: () => T | undefined | false, ms = 60_000, what = 'condition'): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};

test('FL Studio shows up as connected with its tempo and a moving playhead', async () => {
  const first = await waitFor(() => events.find((e) => e.event === 'fl' && e.data.connected), 15_000, 'FL connected');
  assert.equal(first.data.state.tempo, 96);
  assert.match(first.data.state.title, /Spanish Town Dusk/);
  const a = live.fl.state!.posMs;
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(live.fl.state!.posMs - a >= 400, 'playhead advances while FL plays');
  const log = JSON.parse(readFileSync(join(scriptDir, 'fake_fl_log.json'), 'utf8'));
  assert.ok(log.hints.includes('Karta Live connected'));
});

test('seek and stop from the preview move FL Studio', async () => {
  let r = await fetch(`http://127.0.0.1:${PORT}/fl`, { method: 'POST', body: JSON.stringify({ type: 'seek', ms: 20000 }) });
  assert.equal(r.status, 200);
  await waitFor(() => { const s = live.fl.state!; return s.posMs >= 20000 && s.posMs < 22000; }, 3000, 'seek to 20 s');
  r = await fetch(`http://127.0.0.1:${PORT}/fl`, { method: 'POST', body: JSON.stringify({ type: 'stop' }) });
  await waitFor(() => live.fl.state!.playing === false, 3000, 'FL stopped');
  await fetch(`http://127.0.0.1:${PORT}/fl`, { method: 'POST', body: JSON.stringify({ type: 'play' }) });
  await waitFor(() => live.fl.state!.playing === true, 3000, 'FL playing again');
});

test('an export dropped in the Drop folder renders, and every Higgsfield shot streams in live', async () => {
  const drop = join(root, 'Karta Live', 'Drop', 'Spanish Town Dusk.wav');
  wav(drop);
  const job = await waitFor(() => events.find((e) => e.event === 'job' && e.data?.status === 'running'), 15_000, 'job start');
  assert.equal(job.data.title, 'Spanish Town Dusk', 'title comes from the FL project');
  const done = await waitFor(() => events.find((e) => e.event === 'job' && e.data?.status !== 'running'), 240_000, 'job end');
  assert.equal(done.data.status, 'done', done.data.error);

  const eng = events.filter((e) => e.event === 'engine').map((e) => e.data);
  const features = eng.find((e) => e.type === 'features').features;
  assert.ok(Math.abs(features.bpm - 96) <= 2, `bpm ${features.bpm}`);
  assert.ok(Math.abs(features.drop - 20) <= 2.6, `drop at ${features.drop}s`);
  assert.ok(eng.find((e) => e.type === 'art').art.cover.startsWith('/files/'));
  const shots = eng.find((e) => e.type === 'prompts').shots;
  assert.ok(shots.length >= 2);
  for (const [i] of shots.entries()) {
    for (const aspect of ['16:9', '9:16']) {
      const seq = eng.filter((e) => e.type === 'shot' && e.index === i && e.aspect === aspect).map((e) => e.status);
      assert.ok(seq.indexOf('queued') < seq.indexOf('in_progress') && seq.indexOf('in_progress') < seq.indexOf('completed') && seq.at(-1) === 'downloaded', `shot ${i} ${aspect}: ${seq}`);
    }
  }
  assert.ok(eng.some((e) => e.type === 'video' && e.kind === 'cinematicWide'));
  // the clips the window plays are served by Karta Live
  const clip = eng.find((e) => e.type === 'shot' && e.status === 'downloaded').file;
  const r = await fetch(`http://127.0.0.1:${PORT}${clip}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  // Higgsfield got the cover through a public Karta URL and the right shot lengths
  assert.equal(mocks.log.authOk, true);
  assert.equal(mocks.log.uploads[0].type, 'image/jpeg');
  assert.ok(mocks.log.submits.every((s: any) => s.imageFetched === 'image/jpeg' && s.duration >= 4 && s.duration <= 15 && s.generate_audio === false));
  // FL's hint bar heard about it
  const readHints = () => { try { return JSON.parse(readFileSync(join(scriptDir, 'fake_fl_log.json'), 'utf8')).hints as string[]; } catch { return []; } };
  const hints = await waitFor(() => { const h = readHints(); return h.some((x) => /Higgsfield visuals are ready/.test(x)) && h; }, 3000, 'final hint in FL');
  assert.ok(hints.some((h) => /shot 1 is ready/.test(h)), hints.join(' | '));
  assert.ok(existsSync(join(root, 'Karta Live', 'renders', done.data.id, 'youtube-cinematic.mp4')));
});
