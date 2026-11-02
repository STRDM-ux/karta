// Stand-ins for Higgsfield (same request/status/response shapes as docs.higgsfield.ai) and for
// Karta's /studio/live upload, so Karta Live can be tested end to end without real keys.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function startMocks(port = 8791, { pollsPerStage = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hf-mock-'));
  const jobs = new Map(), uploads = new Map();
  const log = { submits: [], uploads: [], authOk: true };
  const base = `http://127.0.0.1:${port}`;
  const clip = (id, aspect, seconds, n) => {
    const f = join(dir, `${id}.mp4`);
    if (existsSync(f)) return f;
    const [w, h] = aspect === '9:16' ? [360, 640] : [640, 360];
    const hues = ['0xff3d8a', '0x00e1ff', '0xffbf33', '0x26d980', '0x9b5cff', '0xff7a00'];
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${hues[n % hues.length]}:s=${w}x${h}:d=${seconds}:r=24`, '-f', 'lavfi', '-i', `testsrc2=s=${w}x${Math.round(h / 3)}:d=${seconds}:r=24`,
      '-filter_complex', `[0][1]overlay=0:${Math.round(h / 3)}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
    return f;
  };
  let n = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, base);
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(body);
      const json = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.method === 'PUT' && url.pathname.startsWith('/studio/live/')) {
        if (req.headers.authorization !== 'Bearer karta-test-token') return json(401, { ok: false, error: 'Sign in to continue.' });
        const id = `u${uploads.size}`;
        uploads.set(id, { type: req.headers['content-type'], data: raw });
        log.uploads.push({ name: url.pathname.split('/').pop(), type: req.headers['content-type'], bytes: raw.length });
        return json(200, { ok: true, data: { url: `${base}/media/live/${id}` } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/media/live/')) {
        const u = uploads.get(url.pathname.split('/').pop());
        if (!u) return json(404, {});
        res.writeHead(200, { 'Content-Type': u.type }); return res.end(u.data);
      }
      const isApi = url.pathname.startsWith('/bytedance/') || url.pathname.startsWith('/requests/');
      if (isApi && req.headers.authorization !== 'Key test-id:test-secret') { log.authOk = false; return json(401, { detail: 'bad key' }); }
      if (req.method === 'POST' && url.pathname === '/bytedance/seedance-2.0/reference-to-video') {
        const b = JSON.parse(raw.toString());
        // Higgsfield fetches the reference image itself: make sure the URL really serves an image
        const img = await fetch(b.image_urls[0]).then((r) => (r.ok ? r.headers.get('content-type') : null)).catch(() => null);
        log.submits.push({ ...b, imageFetched: img });
        if (!img?.startsWith('image/')) return json(422, { detail: 'image_urls[0] could not be fetched' });
        const id = `req${++n}`;
        jobs.set(id, { polls: 0, aspect: b.aspect_ratio, duration: b.duration, n });
        return json(200, { status: 'queued', request_id: id, status_url: `${base}/requests/${id}/status`, cancel_url: `${base}/requests/${id}/cancel` });
      }
      const m = /^\/requests\/(\w+)\/status$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const j = jobs.get(m[1]);
        if (!j) return json(404, {});
        j.polls++;
        const status = j.polls <= pollsPerStage ? 'queued' : j.polls <= pollsPerStage * 2 ? 'in_progress' : 'completed';
        return json(200, { status, request_id: m[1], ...(status === 'completed' ? { video: { url: `${base}/clips/${m[1]}.mp4` } } : {}) });
      }
      const c = /^\/clips\/(\w+)\.mp4$/.exec(url.pathname);
      if (req.method === 'GET' && c) {
        const j = jobs.get(c[1]);
        res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(readFileSync(clip(c[1], j.aspect, Math.min(j.duration, 6), j.n)));
      }
      json(404, { detail: 'not found' });
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, log, close: () => server.close() };
}
