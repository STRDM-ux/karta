import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

/**
 * Higgsfield API client (https://docs.higgsfield.ai).
 * Auth: `Authorization: Key <id>:<secret>`. Every job is queued; poll `status_url` until it ends.
 * Outputs live for about 7 days, so results are downloaded right away.
 */
export class Higgsfield {
  constructor(
    private keyId = process.env.HF_API_KEY_ID ?? '',
    private keySecret = process.env.HF_API_KEY_SECRET ?? '',
    private base = 'https://api.higgsfield.ai',
  ) {
    if (!keyId || !keySecret) throw new Error('Set HF_API_KEY_ID and HF_API_KEY_SECRET to use Higgsfield.');
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Key ${this.keyId}:${this.keySecret}`, 'Content-Type': 'application/json', ...extra };
  }

  async submit(path: string, body: unknown): Promise<{ request_id: string; status_url: string }> {
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers: this.headers({ 'Idempotency-Key': randomUUID() }), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Higgsfield ${path} returned ${res.status}: ${await res.text()}`);
    return res.json() as Promise<{ request_id: string; status_url: string }>;
  }

  async wait(statusUrl: string, { intervalMs = 5000, timeoutMs = 15 * 60_000 } = {}): Promise<HiggsfieldResult> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const res = await fetch(statusUrl, { headers: this.headers() });
      if (!res.ok) throw new Error(`Higgsfield status returned ${res.status}: ${await res.text()}`);
      const r = (await res.json()) as HiggsfieldResult;
      if (r.status === 'completed') return r;
      if (r.status === 'failed' || r.status === 'nsfw' || r.status === 'canceled') throw new Error(`Higgsfield job ended with status "${r.status}"`);
      await new Promise((ok) => setTimeout(ok, intervalMs));
    }
    throw new Error('Higgsfield job timed out');
  }

  /** Seedance 2.0 reference-to-video: the cover art (and optionally the beat) guide the clip. */
  async referenceToVideo(o: { imageUrls: string[]; audioUrls?: string[]; prompt: string; aspect: '16:9' | '9:16' | '1:1'; duration: number; resolution?: '720p' | '1080p' }): Promise<string> {
    const job = await this.submit('/bytedance/seedance-2.0/reference-to-video', {
      prompt: o.prompt,
      image_urls: o.imageUrls,
      ...(o.audioUrls?.length ? { audio_urls: o.audioUrls } : {}),
      aspect_ratio: o.aspect,
      duration: Math.max(4, Math.min(15, Math.round(o.duration))),
      resolution: o.resolution ?? '1080p',
      generate_audio: false, // the beat is laid under the video afterwards
    });
    const r = await this.wait(job.status_url);
    if (!r.video?.url) throw new Error('Higgsfield finished without a video URL');
    return r.video.url;
  }

  /** Soul V2 still image from a prompt (alternate cinematic cover). */
  async image(prompt: string): Promise<string> {
    const job = await this.submit('/higgsfield-ai/soul/v2/standard', { prompt });
    const r = await this.wait(job.status_url);
    const url = r.images?.[0]?.url;
    if (!url) throw new Error('Higgsfield finished without an image URL');
    return url;
  }
}

export interface HiggsfieldResult {
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
  request_id: string;
  images?: { url: string }[];
  video?: { url: string };
}

export async function download(url: string, file: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}
