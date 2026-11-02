import { readFile, stat } from 'node:fs/promises';
import type { VisualDNA } from '../dna.js';

export type Platform = 'youtube' | 'youtube_shorts' | 'tiktok' | 'instagram';

export interface PostAssets {
  wide: string;        // 16:9 video, full beat
  tall: string;        // 9:16 video, cut from the drop
  thumbnail: string;   // 1280x720 jpg
  /** Public URL of the tall video. Instagram pulls video from a URL; it cannot take an upload. */
  tallUrl?: string;
}

export interface Credentials {
  youtubeAccessToken?: string;   // OAuth token with youtube.upload scope
  tiktokAccessToken?: string;    // OAuth token with video.publish scope
  instagramAccessToken?: string; // Instagram API with Instagram Login, Business or Creator account
  instagramUserId?: string;
}

export interface PublishResult { platform: Platform; ok: boolean; id?: string; url?: string; error?: string; note?: string }

export interface Copy { title: string; description: string; caption: string; tags: string[] }

/** Platform copy built from the beat, with lease info and store link. */
export function buildCopy(dna: VisualDNA, opts: { storeUrl?: string; priceFrom?: string; tags?: string[] } = {}): Copy {
  const m = dna.meta;
  const genre = (m.genre || 'Instrumental').replace(/\b\w/g, (c) => c.toUpperCase());
  const typeTags = (opts.tags ?? []).map((t) => t.replace(/\s+/g, ''));
  const tags = [...new Set([genre.toLowerCase().replace(/\s+/g, ''), `${genre.toLowerCase().replace(/\s+/g, '')}beat`, 'typebeat', 'instrumental', 'producer', 'beatsforsale', ...typeTags])].slice(0, 15);
  const buy = opts.storeUrl ? `Buy or lease: ${opts.storeUrl}` : 'Leases and exclusive available. Link in bio.';
  const price = opts.priceFrom ? ` Leases from ${opts.priceFrom}.` : '';
  return {
    title: `${m.title} | ${genre} Beat | ${m.bpm} BPM ${m.key} | prod. ${m.producer}`.slice(0, 100),
    description: [
      `"${m.title}" · ${genre} instrumental · ${m.bpm} BPM · ${m.key}`,
      `Produced by ${m.producer}.${price}`,
      buy,
      '',
      'Free for non-profit use only. Credit (prod. ' + m.producer + ') is required. Purchase a license before releasing.',
      '',
      tags.map((t) => '#' + t).join(' '),
    ].join('\n').slice(0, 5000),
    caption: `${m.title} · ${m.bpm} BPM · ${m.key}\n${dna.mood.slice(0, 2).join(', ')} ${genre.toLowerCase()} 🔊${price}\n${buy}\n\n${tags.slice(0, 8).map((t) => '#' + t).join(' ')}`.slice(0, 2200),
    tags,
  };
}

export async function publish(platforms: Platform[], assets: PostAssets, copy: Copy, creds: Credentials, privacy: 'public' | 'private' | 'unlisted' = 'public'): Promise<PublishResult[]> {
  const out: PublishResult[] = [];
  for (const p of platforms) {
    try {
      if (p === 'youtube') out.push(await youtube(assets.wide, assets.thumbnail, copy, creds, privacy, false));
      else if (p === 'youtube_shorts') out.push(await youtube(assets.tall, undefined, { ...copy, title: `${copy.title.split(' | ')[0]} #shorts`.slice(0, 100) }, creds, privacy, true));
      else if (p === 'tiktok') out.push(await tiktok(assets.tall, copy, creds));
      else if (p === 'instagram') out.push(await instagram(assets.tallUrl, copy, creds));
    } catch (e) {
      out.push({ platform: p, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/* ---------- YouTube Data API v3: resumable upload, then custom thumbnail ---------- */
async function youtube(file: string, thumb: string | undefined, copy: Copy, c: Credentials, privacy: string, short: boolean): Promise<PublishResult> {
  const platform: Platform = short ? 'youtube_shorts' : 'youtube';
  if (!c.youtubeAccessToken) return { platform, ok: false, error: 'YouTube is not connected' };
  const size = (await stat(file)).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.youtubeAccessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({
      snippet: { title: copy.title, description: copy.description, tags: copy.tags, categoryId: '10' }, // 10 = Music
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) throw new Error(`YouTube upload start failed (${init.status}): ${await init.text()}`);
  const location = init.headers.get('location');
  if (!location) throw new Error('YouTube did not return an upload URL');
  const up = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: await readFile(file) });
  if (!up.ok) throw new Error(`YouTube upload failed (${up.status}): ${await up.text()}`);
  const video = (await up.json()) as { id: string };
  let note: string | undefined;
  if (thumb) {
    const t = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.youtubeAccessToken}`, 'Content-Type': 'image/jpeg' }, body: await readFile(thumb),
    });
    // custom thumbnails need a verified channel; the video is still up if this fails
    if (!t.ok) note = `Video is up, but the thumbnail was refused (${t.status}). Verify the channel to allow custom thumbnails.`;
  }
  return { platform, ok: true, id: video.id, url: short ? `https://youtube.com/shorts/${video.id}` : `https://youtu.be/${video.id}`, note };
}

/* ---------- TikTok Content Posting API (same flow as STRDM social-studio) ---------- */
async function tiktok(file: string, copy: Copy, c: Credentials): Promise<PublishResult> {
  if (!c.tiktokAccessToken) return { platform: 'tiktok', ok: false, error: 'TikTok is not connected' };
  const API = 'https://open.tiktokapis.com/v2';
  const call = async (path: string, body: unknown) => {
    const res = await fetch(API + path, { method: 'POST', headers: { Authorization: `Bearer ${c.tiktokAccessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { code?: string; message?: string } };
    if (!res.ok || (data.error?.code && data.error.code !== 'ok')) {
      const code = data.error?.code ?? String(res.status);
      throw new Error(`TikTok: ${data.error?.message || code}${code === 'unaudited_client_can_only_post_to_private_accounts' ? ' (until the TikTok app passes audit, posts can only be private)' : ''}`);
    }
    return data.data ?? {};
  };
  const info = await call('/post/publish/creator_info/query/', {});
  const options = (info.privacy_level_options as string[] | undefined) ?? ['SELF_ONLY'];
  const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : options[0];
  const bytes = await readFile(file);
  const size = bytes.length;
  const chunkSize = size <= 64_000_000 ? size : 10_000_000;
  const chunks = Math.floor(size / chunkSize);
  const init = await call('/post/publish/video/init/', {
    post_info: { title: copy.caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false, video_cover_timestamp_ms: 1000 },
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: chunks },
  });
  const uploadUrl = String(init.upload_url ?? '');
  const publishId = String(init.publish_id ?? '');
  for (let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = i === chunks - 1 ? size - 1 : start + chunkSize - 1;
    const up = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}` }, body: bytes.subarray(start, end + 1) });
    if (!up.ok && up.status !== 206) throw new Error(`TikTok upload failed (${up.status})`);
  }
  for (let tries = 0; tries < 40; tries++) {
    await sleep(15_000);
    const s = await call('/post/publish/status/fetch/', { publish_id: publishId });
    const st = String(s.status ?? '');
    if (st === 'FAILED') throw new Error(`TikTok rejected the post: ${String(s.fail_reason ?? 'unknown')}`);
    if (st === 'PUBLISH_COMPLETE' || st === 'SEND_TO_USER_INBOX') {
      const ids = s.publicaly_available_post_id as unknown[] | undefined;
      return { platform: 'tiktok', ok: true, id: ids?.length ? String(ids[0]) : publishId, note: privacy !== 'PUBLIC_TO_EVERYONE' ? `Posted as ${privacy}` : undefined };
    }
  }
  return { platform: 'tiktok', ok: true, id: publishId, note: 'Uploaded; TikTok is still processing it' };
}

/* ---------- Instagram Reels via Instagram API with Instagram Login (same flow as STRDM) ---------- */
async function instagram(videoUrl: string | undefined, copy: Copy, c: Credentials): Promise<PublishResult> {
  if (!c.instagramAccessToken || !c.instagramUserId) return { platform: 'instagram', ok: false, error: 'Instagram is not connected' };
  if (!videoUrl) return { platform: 'instagram', ok: false, error: 'Instagram needs the video at a public URL. Set an uploader so the tall video gets one.' };
  const G = 'https://graph.instagram.com/v23.0';
  const call = async (path: string, params: Record<string, string>, method = 'POST') => {
    const q = new URLSearchParams({ ...params, access_token: c.instagramAccessToken! });
    const res = await fetch(`${G}${path}${method === 'GET' ? `?${q}` : ''}`, method === 'GET' ? {} : { method, body: q });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok || data.error) throw new Error(`Instagram: ${data.error?.message ?? res.status}`);
    return data;
  };
  const container = await call(`/${c.instagramUserId}/media`, { media_type: 'REELS', video_url: videoUrl, caption: copy.caption, share_to_feed: 'true' });
  for (let tries = 0; tries < 60; tries++) {
    await sleep(tries === 0 ? 20_000 : 15_000);
    const s = await call(`/${container.id}`, { fields: 'status_code,status' }, 'GET');
    const code = String(s.status_code ?? '');
    if (code === 'ERROR' || code === 'EXPIRED') throw new Error(`Instagram couldn't process the video: ${String(s.status ?? code)}`);
    if (code === 'FINISHED') {
      const pub = await call(`/${c.instagramUserId}/media_publish`, { creation_id: String(container.id) });
      const link = (await call(`/${pub.id}`, { fields: 'permalink' }, 'GET').catch(() => ({}))) as { permalink?: string };
      return { platform: 'instagram', ok: true, id: String(pub.id), url: link.permalink };
    }
  }
  throw new Error('Instagram took too long to process the video');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
