// Files live in MediaStore objects (one per file), chunked like STRDM's SocialMedia store.
import { doFetcher, doRequest, type DOEnv } from './do';
import { ApiError } from './util';
import { CHUNK_BYTES, MAX_BYTES } from '../media-store';

const id = (key: string) => `m:${key}`;
const base = (key: string) => `https://karta.internal/media/${encodeURIComponent(key)}`;

async function ok(res: Response, what: string): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status === 400 ? 400 : 502, String(data.error ?? `${what} failed`));
  return data;
}

/** One request with the whole file (up to the worker's request limit); split into chunks here. */
export async function putWhole(env: DOEnv, key: string, data: ArrayBuffer, mime: string): Promise<void> {
  if (data.byteLength > MAX_BYTES) throw new ApiError(413, 'Files can be up to 500 MB.');
  const d = doFetcher(env);
  await ok(await d.fetch(doRequest('MediaStore', id(key), `${base(key)}/init`, { method: 'POST', body: JSON.stringify({ size: data.byteLength, mime }) })), 'Upload');
  for (let n = 0; n * CHUNK_BYTES < data.byteLength; n++) {
    await ok(await d.fetch(doRequest('MediaStore', id(key), `${base(key)}/chunk/${n}`, { method: 'PUT', body: data.slice(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES) })), 'Upload');
  }
}

/** Chunked upload from the browser: part 0 starts the file; returns whether it is complete. */
export async function putPart(env: DOEnv, key: string, o: { size: number; part: number; mime: string; data: ArrayBuffer }): Promise<boolean> {
  if (!(o.size > 0) || o.size > MAX_BYTES) throw new ApiError(413, 'Files can be up to 500 MB.');
  const d = doFetcher(env);
  if (o.part === 0) await ok(await d.fetch(doRequest('MediaStore', id(key), `${base(key)}/init`, { method: 'POST', body: JSON.stringify({ size: o.size, mime: o.mime }) })), 'Upload');
  const r = await ok(await d.fetch(doRequest('MediaStore', id(key), `${base(key)}/chunk/${o.part}`, { method: 'PUT', body: o.data })), 'Upload');
  return r.complete === true;
}

export function getMedia(env: DOEnv, key: string, req: Request): Promise<Response> {
  const headers: Record<string, string> = {};
  const range = req.headers.get('Range');
  if (range) headers.Range = range;
  return doFetcher(env).fetch(doRequest('MediaStore', id(key), base(key), { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }));
}

export async function deleteMedia(env: DOEnv, key: string): Promise<void> {
  await doFetcher(env).fetch(doRequest('MediaStore', id(key), base(key), { method: 'DELETE' })).catch(() => undefined);
}

export { CHUNK_BYTES };
