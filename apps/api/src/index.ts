import { ApiError, CORS, json, timingSafeEqual } from './util';
import { handleCharts } from './charts';
import { verifyStripeSignature } from './stripe';
import { KartaDB, type Env } from './db';

export { KartaDB };

type Ctx = { env: Env; request: Request; url: URL; params: string[]; token: string | null; ctx: ExecutionContext };
type Handler = (c: Ctx) => Promise<Response> | Response;

const routes: { method: string; re: RegExp; h: Handler }[] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push({ method, re: new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h });

const stub = (env: Env) => env.DB.get(env.DB.idFromName('global'));
/** Runs an op in the Durable Object; its errors come back as data so the status survives RPC. */
async function op<T = unknown>(env: Env, name: string, token: string | null, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await stub(env).api(name, token, args)) as { ok: boolean; data?: unknown; status?: number; error?: string };
  if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'Something went wrong.');
  return r.data as T;
}
const db = (env: Env) => ({ api: <T = unknown>(name: string, token: string | null, args: Record<string, unknown> = {}) => op<T>(env, name, token, args) });
const call = async (c: Ctx, name: string, args: Record<string, unknown> = {}) => json({ ok: true, data: await op(c.env, name, c.token, args) });
const body = async (r: Request): Promise<Record<string, unknown>> => { try { return (await r.json()) as Record<string, unknown>; } catch { return {}; } };
const q = (u: URL) => Object.fromEntries(u.searchParams.entries());

const MAX_UPLOAD = 500 * 1024 * 1024;
const TYPES: Record<string, string> = { preview: 'audio/mpeg', mp3: 'audio/mpeg', wav: 'audio/wav', stems: 'application/zip', cover: 'image/jpeg' };

/* auth */
route('POST', '/auth/signup', async (c) => call(c, 'signup', await body(c.request)));
route('POST', '/auth/login', async (c) => call(c, 'login', await body(c.request)));
route('POST', '/auth/logout', async (c) => call(c, 'logout', { token: c.token }));
route('GET', '/me', (c) => call(c, 'me'));
route('PATCH', '/me', async (c) => call(c, 'updateProfile', await body(c.request)));
route('POST', '/me/password', async (c) => call(c, 'changePassword', await body(c.request)));
route('PUT', '/me/(avatar|banner)', async (c) => {
  const me = (await db(c.env).api('me', c.token, {})) as { id: string };
  const type = c.request.headers.get('Content-Type') ?? '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new ApiError(400, 'Upload a JPG, PNG or WebP image.');
  const len = Number(c.request.headers.get('Content-Length') ?? 0);
  if (len > 8 * 1024 * 1024) throw new ApiError(413, 'Images can be up to 8 MB.');
  await c.env.FILES.put(`profiles/${me.id}/${c.params[0]}`, c.request.body, { httpMetadata: { contentType: type } });
  return call(c, 'setProfileImage', { kind: c.params[0] });
});

/* profiles, follows, search */
route('GET', '/u/:handle', (c) => call(c, 'profile', { handle: c.params[0] }));
route('POST', '/u/:handle/follow', async (c) => call(c, 'follow', { handle: c.params[0], ...(await body(c.request)) }));
route('GET', '/search', (c) => call(c, 'search', q(c.url)));

/* store */
route('GET', '/store', (c) => call(c, 'store', q(c.url)));
route('GET', '/beats/:id', (c) => call(c, 'beat', { id: c.params[0] }));
route('POST', '/beats/:id/play', (c) => call(c, 'play', { id: c.params[0] }));
route('POST', '/beats/:id/favorite', async (c) => call(c, 'favorite', { id: c.params[0], ...(await body(c.request)) }));

/* producer studio */
route('GET', '/studio/beats', (c) => call(c, 'myBeats'));
route('GET', '/studio/sales', (c) => call(c, 'mySales'));
route('POST', '/studio/beats', async (c) => call(c, 'createBeat', await body(c.request)));
route('PATCH', '/studio/beats/:id', async (c) => call(c, 'updateBeat', { ...(await body(c.request)), id: c.params[0] }));
route('DELETE', '/studio/beats/:id', async (c) => {
  const res = (await db(c.env).api('deleteBeat', c.token, { id: c.params[0] })) as { files: string[] };
  c.ctx.waitUntil(Promise.all(res.files.map((k) => c.env.FILES.delete(k))).then(() => undefined));
  return json({ ok: true, data: { deleted: true } });
});
route('POST', '/studio/beats/:id/publish', async (c) => call(c, 'publishBeat', { ...(await body(c.request)), id: c.params[0] }));
route('PUT', '/studio/beats/:id/files/:kind', async (c) => {
  const { key } = (await db(c.env).api('authorizeUpload', c.token, { id: c.params[0], kind: c.params[1] })) as { key: string };
  const len = Number(c.request.headers.get('Content-Length') ?? 0);
  if (len > MAX_UPLOAD) throw new ApiError(413, 'Files can be up to 500 MB.');
  if (!c.request.body) throw new ApiError(400, 'The upload was empty.');
  await c.env.FILES.put(key, c.request.body, { httpMetadata: { contentType: c.request.headers.get('Content-Type') || TYPES[c.params[1]] } });
  return call(c, 'fileUploaded', { id: c.params[0], kind: c.params[1], key });
});
route('POST', '/studio/beats/:id/art', async (c) => {
  const job = (await db(c.env).api('startArt', c.token, { id: c.params[0], ...(await body(c.request)) })) as { jobId: string; audioKey: string; meta: unknown; pattern?: string };
  const origin = c.url.origin;
  const res = await fetch(`${c.env.RENDER_URL!.replace(/\/$/, '')}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.env.RENDER_SECRET ?? ''}` },
    body: JSON.stringify({ jobId: job.jobId, meta: job.meta, pattern: job.pattern, audioUrl: `${origin}/internal/jobs/${job.jobId}/audio`, callback: `${origin}/internal/jobs/${job.jobId}` }),
  }).catch(() => null);
  if (!res?.ok) {
    await db(c.env).api('artDone', null, { jobId: job.jobId, error: 'The art renderer didn’t answer. Try again in a minute.' });
    throw new ApiError(502, 'The art renderer didn’t answer. Try again in a minute.');
  }
  return json({ ok: true, data: { jobId: job.jobId, status: 'queued' } });
});
route('GET', '/studio/beats/:id/art', (c) => call(c, 'artStatus', { id: c.params[0] }));
route('POST', '/studio/payouts', (c) => call(c, 'payoutsLink'));
route('GET', '/studio/payouts', (c) => call(c, 'payoutsStatus'));
route('POST', '/studio/payouts/dashboard', (c) => call(c, 'dashboardLink'));

/* buyer */
route('GET', '/library', (c) => call(c, 'library'));
route('POST', '/checkout', async (c) => call(c, 'checkout', await body(c.request)));
route('GET', '/dl/:token/:kind', async (c) => {
  const r = (await db(c.env).api('resolveDownload', null, { token: c.params[0], kind: c.params[1] })) as { key?: string; filename?: string; agreement?: string };
  if (r.agreement) return new Response(r.agreement, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="karta-license.txt"' } });
  const obj = await c.env.FILES.get(r.key!);
  if (!obj) throw new ApiError(404, 'That file is missing. Contact the producer.');
  return new Response(obj.body, { headers: { ...CORS, 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'Content-Disposition': `attachment; filename="${r.filename}"`, 'Cache-Control': 'private, no-store' } });
});

/* public media (previews, covers, generated art, profile images) */
route('GET', '/media/(beats|profiles)/:id/:kind', async (c) => {
  const { key } = (await db(c.env).api('mediaKey', c.token, { scope: c.params[0], id: c.params[1], kind: c.params[2] })) as { key: string };
  const range = c.request.headers.get('Range');
  const obj = await c.env.FILES.get(key, range ? { range: c.request.headers } : undefined);
  if (!obj) throw new ApiError(404, 'Not found');
  const h: Record<string, string> = { ...CORS, 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'Accept-Ranges': 'bytes', ETag: obj.httpEtag };
  if (range && 'range' in obj && obj.range) {
    const rg = obj.range as { offset: number; length: number };
    h['Content-Range'] = `bytes ${rg.offset}-${rg.offset + rg.length - 1}/${obj.size}`;
    h['Content-Length'] = String(rg.length);
    return new Response(obj.body, { status: 206, headers: h });
  }
  h['Content-Length'] = String(obj.size);
  return new Response(obj.body, { headers: h });
});

/* feed + charts */
route('GET', '/feed', (c) => call(c, 'feed', q(c.url)));
route('GET', '/u/:handle/posts', (c) => call(c, 'feed', { ...q(c.url), scope: 'user', handle: c.params[0] }));
route('POST', '/posts', async (c) => call(c, 'createPost', await body(c.request)));
route('POST', '/posts/:id/like', async (c) => call(c, 'likePost', { id: c.params[0], ...(await body(c.request)) }));
route('POST', '/posts/:id/repost', async (c) => call(c, 'repost', { id: c.params[0], ...(await body(c.request)) }));
route('DELETE', '/posts/:id', (c) => call(c, 'deletePost', { id: c.params[0] }));
route('GET', '/charts/apple', (c) => handleCharts(c.url, c.ctx));

/* Stripe webhook */
route('POST', '/stripe/webhook', async (c) => {
  const raw = await c.request.text();
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'Webhook not configured');
  if (!(await verifyStripeSignature(raw, c.request.headers.get('Stripe-Signature') ?? '', c.env.STRIPE_WEBHOOK_SECRET))) throw new ApiError(400, 'Bad signature');
  return json({ ok: true, data: await db(c.env).api('stripeEvent', null, { event: JSON.parse(raw) }) });
});

/* render server (authenticated with RENDER_SECRET) */
const renderAuth = (c: Ctx) => {
  const got = c.request.headers.get('Authorization') ?? '';
  if (!c.env.RENDER_SECRET || !timingSafeEqual(got, `Bearer ${c.env.RENDER_SECRET}`)) throw new ApiError(401, 'Unauthorized');
};
route('GET', '/internal/jobs/:id/audio', async (c) => {
  renderAuth(c);
  const job = (await db(c.env).api('artJob', null, { jobId: c.params[0] })) as { beatId: string } | null;
  if (!job) throw new ApiError(404, 'Unknown job');
  const { key } = (await db(c.env).api('mediaKey', null, { scope: 'beats', id: job.beatId, kind: 'preview' }).catch(() => ({ key: '' }))) as { key: string };
  const wav = await c.env.FILES.get(`beats/${job.beatId}/wav`) ?? await c.env.FILES.get(`beats/${job.beatId}/mp3`) ?? (key ? await c.env.FILES.get(key) : null);
  if (!wav) throw new ApiError(404, 'No audio');
  return new Response(wav.body, { headers: { 'Content-Type': wav.httpMetadata?.contentType ?? 'audio/mpeg' } });
});
route('PUT', '/internal/jobs/:id/files/:kind', async (c) => {
  renderAuth(c);
  const kind = c.params[1];
  if (!['cover', 'thumbnail', 'youtube', 'short', 'cinematic', 'shortCinematic'].includes(kind)) throw new ApiError(400, 'Unknown art kind');
  const job = (await db(c.env).api('artJob', null, { jobId: c.params[0] })) as { beatId: string } | null;
  if (!job) throw new ApiError(404, 'Unknown job');
  const key = `beats/${job.beatId}/art-${kind}`;
  await c.env.FILES.put(key, c.request.body, { httpMetadata: { contentType: c.request.headers.get('Content-Type') ?? 'application/octet-stream' } });
  return json({ ok: true, data: { key } });
});
route('POST', '/internal/jobs/:id', async (c) => { renderAuth(c); return call(c, 'artDone', { ...(await body(c.request)), jobId: c.params[0] }); });

/* local development without Stripe keys */
route('POST', '/dev/payouts-ready', (c) => call(c, 'devPayoutsReady'));
route('POST', '/dev/checkout', async (c) => call(c, 'devCheckout', await body(c.request)));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/)/, '').replace(/\/$/, '') || '/';
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') && !path.startsWith('/internal/') ? auth.slice(7) : null;
    try {
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = r.re.exec(path);
        if (m) return await r.h({ env, request, url, params: m.slice(1).map(decodeURIComponent), token, ctx });
      }
      if (path === '/' || path === '/health') return json({ ok: true, service: 'karta-api' });
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      if (status >= 500) console.error(e);
      return json({ ok: false, error: e instanceof ApiError ? e.message : 'Something went wrong. Try again.' }, status);
    }
  },
};
