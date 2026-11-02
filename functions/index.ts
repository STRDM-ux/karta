// functions/index.ts | Karta backend (Cloudflare Worker), laid out like STRDM's backend so Rork deploys it the same way.
//
//  • KartaDB ("global") holds accounts, profiles and settings, beats, store, orders, licenses, feed and art jobs.
//  • MediaStore (one object per file) holds audio, covers, generated art and profile images.
//  • Accounts are Karta's own, or "Continue with STRDM": the STRDM backend checks the password and
//    Karta links the account by email, so one login works across STRDM, STRDM Live and Karta.
//  • /charts/apple is STRDM's chart. The render server authenticates with RENDER_SECRET.

import { ApiError, CORS, json, text, timingSafeEqual } from './lib/util';
import { doFetcher, doRequest, isInternal, type DOEnv } from './lib/do';
import { deleteMedia, getMedia, putPart, putWhole } from './lib/media';
import { verifyStripeSignature } from './lib/stripe';
import { handleCharts } from './charts';
import type { Env as DBEnv } from './karta-db';

export { KartaDB } from './karta-db';
export { MediaStore } from './media-store';

export type Env = DBEnv & DOEnv & { STRDM_BACKEND_URL?: string };

const STRDM_BACKEND = 'https://ronthpnsqlinal2f2gn69-backend.rork.app';
const MAX_WHOLE = 95 * 1024 * 1024; // above this the browser sends 4 MB parts
const AUDIO: Record<string, string> = { preview: 'audio/mpeg', mp3: 'audio/mpeg', wav: 'audio/wav', stems: 'application/zip', cover: 'image/jpeg' };

type Ctx = { env: Env; request: Request; url: URL; params: string[]; token: string | null; ctx: ExecutionContext };
type Handler = (c: Ctx) => Promise<Response> | Response;
const routes: { method: string; re: RegExp; h: Handler }[] = [];
const route = (method: string, path: string, h: Handler) => routes.push({ method, re: new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h });

/** Runs an op in KartaDB; errors come back as data so the status survives the hop. */
async function op<T = unknown>(env: Env, name: string, token: string | null, args: Record<string, unknown> = {}): Promise<T> {
  const res = await doFetcher(env).fetch(doRequest('KartaDB', 'global', 'https://karta.internal/op', { method: 'POST', body: JSON.stringify({ op: name, token, args }) }));
  const r = (await res.json().catch(() => ({ ok: false, status: 502, error: 'The database didn’t answer.' }))) as { ok: boolean; data?: unknown; status?: number; error?: string };
  if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'Something went wrong.');
  return r.data as T;
}
const call = async (c: Ctx, name: string, args: Record<string, unknown> = {}) => json({ ok: true, data: await op(c.env, name, c.token, args) });
const body = async (r: Request): Promise<Record<string, unknown>> => { try { return (await r.json()) as Record<string, unknown>; } catch { return {}; } };
const q = (u: URL) => Object.fromEntries(u.searchParams.entries());

/** Whole-file PUT, or 4 MB parts with X-Upload-Size / X-Upload-Part. Returns true once the file is complete. */
async function receive(c: Ctx, key: string, mime: string): Promise<boolean> {
  const data = await c.request.arrayBuffer();
  if (!data.byteLength) throw new ApiError(400, 'The upload was empty.');
  const size = Number(c.request.headers.get('X-Upload-Size') ?? 0);
  if (size) return putPart(c.env, key, { size, part: Number(c.request.headers.get('X-Upload-Part') ?? 0), mime, data });
  if (data.byteLength > MAX_WHOLE) throw new ApiError(413, 'Send files over 95 MB in parts.');
  await putWhole(c.env, key, data, mime);
  return true;
}

function streamMedia(res: Response, extra: Record<string, string> = {}): Response {
  if (!res.ok && res.status !== 206) throw new ApiError(res.status === 416 ? 416 : 404, 'Not found');
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...CORS, ...extra })) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------- accounts ---------- */
route('POST', '/auth/signup', async (c) => call(c, 'signup', await body(c.request)));
route('POST', '/auth/login', async (c) => call(c, 'login', await body(c.request)));
route('POST', '/auth/strdm', async (c) => {
  const b = await body(c.request);
  const base = (c.env.STRDM_BACKEND_URL ?? STRDM_BACKEND).replace(/\/$/, '');
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: text(b.email, 200), password: typeof b.password === 'string' ? b.password : '', ...(b.code ? { code: text(b.code, 12) } : {}) }),
  }).catch(() => null);
  if (!res) throw new ApiError(502, 'STRDM sign-in is unavailable right now. Try again, or use a Karta password.');
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; user?: { id?: string; email?: string; name?: string }; error?: string; twofa?: boolean; requires2fa?: boolean };
  if (!res.ok || !data.user?.email) {
    if (data.twofa || data.requires2fa) throw new ApiError(401, 'Enter the 6-digit code from your authenticator app.');
    throw new ApiError(res.status === 429 ? 429 : 401, data.error ?? 'That STRDM email and password don’t match.');
  }
  return call(c, 'strdmLogin', { email: data.user.email, name: data.user.name, strdmId: data.user.id, role: b.role, handle: b.handle });
});
route('POST', '/auth/logout', async (c) => call(c, 'logout', { token: c.token }));
route('GET', '/me', (c) => call(c, 'me'));
route('PATCH', '/me', async (c) => call(c, 'updateProfile', await body(c.request)));
route('POST', '/me/password', async (c) => call(c, 'changePassword', await body(c.request)));
route('PUT', '/me/(avatar|banner)', async (c) => {
  const me = await op<{ id: string }>(c.env, 'me', c.token);
  const type = c.request.headers.get('Content-Type') ?? '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new ApiError(400, 'Upload a JPG, PNG or WebP image.');
  const data = await c.request.arrayBuffer();
  if (data.byteLength > 8 * 1024 * 1024) throw new ApiError(413, 'Images can be up to 8 MB.');
  await putWhole(c.env, `profiles/${me.id}/${c.params[0]}`, data, type);
  return call(c, 'setProfileImage', { kind: c.params[0] });
});

/* ---------- profiles, follows, search ---------- */
route('GET', '/u/:handle', (c) => call(c, 'profile', { handle: c.params[0] }));
route('GET', '/u/:handle/posts', (c) => call(c, 'feed', { ...q(c.url), scope: 'user', handle: c.params[0] }));
route('POST', '/u/:handle/follow', async (c) => call(c, 'follow', { handle: c.params[0], ...(await body(c.request)) }));
route('GET', '/search', (c) => call(c, 'search', q(c.url)));

/* ---------- store ---------- */
route('GET', '/store', (c) => call(c, 'store', q(c.url)));
route('GET', '/beats/:id', (c) => call(c, 'beat', { id: c.params[0] }));
route('POST', '/beats/:id/play', (c) => call(c, 'play', { id: c.params[0] }));
route('POST', '/beats/:id/favorite', async (c) => call(c, 'favorite', { id: c.params[0], ...(await body(c.request)) }));

/* ---------- producer studio ---------- */
route('GET', '/studio/beats', (c) => call(c, 'myBeats'));
route('GET', '/studio/sales', (c) => call(c, 'mySales'));
route('POST', '/studio/beats', async (c) => call(c, 'createBeat', await body(c.request)));
route('PATCH', '/studio/beats/:id', async (c) => call(c, 'updateBeat', { ...(await body(c.request)), id: c.params[0] }));
route('DELETE', '/studio/beats/:id', async (c) => {
  const res = await op<{ files: string[] }>(c.env, 'deleteBeat', c.token, { id: c.params[0] });
  c.ctx.waitUntil(Promise.all(res.files.map((k) => deleteMedia(c.env, k))).then(() => undefined));
  return json({ ok: true, data: { deleted: true } });
});
route('POST', '/studio/beats/:id/publish', async (c) => call(c, 'publishBeat', { ...(await body(c.request)), id: c.params[0] }));
route('PUT', '/studio/beats/:id/files/:kind', async (c) => {
  const { key } = await op<{ key: string }>(c.env, 'authorizeUpload', c.token, { id: c.params[0], kind: c.params[1] });
  const done = await receive(c, key, c.request.headers.get('Content-Type') || AUDIO[c.params[1]]);
  if (!done) return json({ ok: true, data: { complete: false } });
  return call(c, 'fileUploaded', { id: c.params[0], kind: c.params[1], key });
});
route('POST', '/studio/beats/:id/art', async (c) => {
  const job = await op<{ jobId: string; meta: unknown; pattern?: string }>(c.env, 'startArt', c.token, { id: c.params[0], ...(await body(c.request)) });
  const origin = c.url.origin;
  const res = await fetch(`${c.env.RENDER_URL!.replace(/\/$/, '')}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.env.RENDER_SECRET ?? ''}` },
    body: JSON.stringify({ jobId: job.jobId, meta: job.meta, pattern: job.pattern, api: origin }),
  }).catch(() => null);
  if (!res?.ok) {
    await op(c.env, 'artDone', null, { jobId: job.jobId, error: 'The art renderer didn’t answer.' });
    throw new ApiError(502, 'The art renderer didn’t answer. Try again in a minute.');
  }
  return json({ ok: true, data: { jobId: job.jobId, status: 'queued' } });
});
route('GET', '/studio/beats/:id/art', (c) => call(c, 'artStatus', { id: c.params[0] }));
route('POST', '/studio/payouts', (c) => call(c, 'payoutsLink'));
route('GET', '/studio/payouts', (c) => call(c, 'payoutsStatus'));
route('POST', '/studio/payouts/dashboard', (c) => call(c, 'dashboardLink'));

/* ---------- buyers ---------- */
route('GET', '/library', (c) => call(c, 'library'));
route('POST', '/checkout', async (c) => call(c, 'checkout', await body(c.request)));
route('GET', '/dl/:token/:kind', async (c) => {
  const r = await op<{ key?: string; filename?: string; agreement?: string }>(c.env, 'resolveDownload', null, { token: c.params[0], kind: c.params[1] });
  if (r.agreement) return new Response(r.agreement, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="karta-license.txt"' } });
  return streamMedia(await getMedia(c.env, r.key!, c.request), { 'Content-Disposition': `attachment; filename="${r.filename}"`, 'Cache-Control': 'private, no-store' });
});

/* ---------- public media: previews, covers, generated art, profile images ---------- */
route('GET', '/media/(beats|profiles)/:id/:kind', async (c) => {
  const { key } = await op<{ key: string }>(c.env, 'mediaKey', c.token, { scope: c.params[0], id: c.params[1], kind: c.params[2] });
  return streamMedia(await getMedia(c.env, key, c.request), { 'Cache-Control': 'public, max-age=3600' });
});

/* ---------- feed + charts ---------- */
route('GET', '/feed', (c) => call(c, 'feed', q(c.url)));
route('POST', '/posts', async (c) => call(c, 'createPost', await body(c.request)));
route('POST', '/posts/:id/like', async (c) => call(c, 'likePost', { id: c.params[0], ...(await body(c.request)) }));
route('POST', '/posts/:id/repost', async (c) => call(c, 'repost', { id: c.params[0], ...(await body(c.request)) }));
route('DELETE', '/posts/:id', (c) => call(c, 'deletePost', { id: c.params[0] }));
route('GET', '/charts/apple', (c) => handleCharts(c.url, c.ctx));

/* ---------- Stripe webhook ---------- */
route('POST', '/stripe/webhook', async (c) => {
  const raw = await c.request.text();
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'Webhook not configured');
  if (!(await verifyStripeSignature(raw, c.request.headers.get('Stripe-Signature') ?? '', c.env.STRIPE_WEBHOOK_SECRET))) throw new ApiError(400, 'Bad signature');
  return json({ ok: true, data: await op(c.env, 'stripeEvent', null, { event: JSON.parse(raw) }) });
});

/* ---------- render server (RENDER_SECRET) ---------- */
const renderAuth = (c: Ctx) => {
  if (!c.env.RENDER_SECRET || !timingSafeEqual(c.request.headers.get('Authorization') ?? '', `Bearer ${c.env.RENDER_SECRET}`)) throw new ApiError(401, 'Unauthorized');
};
route('GET', '/internal/jobs/:id/audio', async (c) => {
  renderAuth(c);
  const { key } = await op<{ key: string }>(c.env, 'jobAudio', null, { jobId: c.params[0] });
  return streamMedia(await getMedia(c.env, key, c.request));
});
route('PUT', '/internal/jobs/:id/files/:kind', async (c) => {
  renderAuth(c);
  const { key } = await op<{ key: string }>(c.env, 'jobFileKey', null, { jobId: c.params[0], kind: c.params[1] });
  await receive(c, key, c.request.headers.get('Content-Type') ?? 'application/octet-stream');
  return json({ ok: true, data: { key } });
});
route('POST', '/internal/jobs/:id', async (c) => { renderAuth(c); return call(c, 'artDone', { ...(await body(c.request)), jobId: c.params[0] }); });

/* ---------- local development without Stripe keys ---------- */
route('POST', '/dev/payouts-ready', (c) => call(c, 'devPayoutsReady'));
route('POST', '/dev/checkout', async (c) => call(c, 'devCheckout', await body(c.request)));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    // the internal marker is only ever set inside the backend
    if (isInternal(request)) return json({ ok: false, error: 'Forbidden' }, 403);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/)/, '').replace(/\/$/, '') || '/';
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') && !path.startsWith('/internal/') ? auth.slice(7) : null;
    try {
      for (const r of routes) {
        if (r.method !== request.method && !(r.method === 'GET' && request.method === 'HEAD')) continue;
        const m = r.re.exec(path);
        if (m) return await r.h({ env, request, url, params: m.slice(1).map(decodeURIComponent), token, ctx });
      }
      if (path === '/' || path === '/health') return json({ ok: true, service: 'karta' });
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      if (status >= 500) console.error(e);
      return json({ ok: false, error: e instanceof ApiError ? e.message : 'Something went wrong. Try again.' }, status);
    }
  },
};
