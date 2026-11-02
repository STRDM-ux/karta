import { DurableObject } from 'cloudflare:workers';
import { ApiError, cents, cleanHandle, multiline, randomToken, sha256Hex, text, uid } from './lib/util';
import { DEFAULT_PRICES, LICENSES, LICENSE_IDS, type FileKind, type LicenseId } from './lib/licenses';
import { stripe } from './lib/stripe';
import { isInternal } from './lib/do';

export interface Env {
  WEB_URL?: string;
  PLATFORM_FEE_BPS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RENDER_URL?: string;
  RENDER_SECRET?: string;
}

type Role = 'producer' | 'buyer';
type Row = Record<string, SqlStorageValue>;
type Viewer = { id: string; role: Role; email: string } | null;
type Args = Record<string, unknown>;

const DAY = 86_400_000;
const SESSION_DAYS = 60;
const PAGE = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  genres TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}',
  stripe_account TEXT NOT NULL DEFAULT '', payouts_ready INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS beats (
  id TEXT PRIMARY KEY, producer_id TEXT NOT NULL, title TEXT NOT NULL, bpm INTEGER NOT NULL DEFAULT 0, musical_key TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', prices TEXT NOT NULL DEFAULT '{}', files TEXT NOT NULL DEFAULT '{}',
  art TEXT NOT NULL DEFAULT '{}', plays INTEGER NOT NULL DEFAULT 0, sold_to TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, published_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS beats_producer ON beats (producer_id);
CREATE INDEX IF NOT EXISTS beats_status ON beats (status, published_at);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL DEFAULT '', buyer_email TEXT NOT NULL DEFAULT '', beat_id TEXT NOT NULL, producer_id TEXT NOT NULL,
  license TEXT NOT NULL, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, status TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, paid_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS orders_producer ON orders (producer_id, status);
CREATE INDEX IF NOT EXISTS orders_buyer ON orders (buyer_id, status);
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, buyer_id TEXT NOT NULL, beat_id TEXT NOT NULL, license TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL, token TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS favorites (user_id TEXT NOT NULL, beat_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, beat_id));
CREATE TABLE IF NOT EXISTS follows (follower TEXT NOT NULL, followee TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower, followee));
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, beat_id TEXT NOT NULL DEFAULT '', repost_of TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS posts_time ON posts (created_at);
CREATE TABLE IF NOT EXISTS post_likes (post_id TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, owner));
CREATE TABLE IF NOT EXISTS art_jobs (id TEXT PRIMARY KEY, beat_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

const DEFAULT_SETTINGS = {
  notifications: { sales: true, follows: true, likes: false, weeklyDigest: true },
  privacy: { showPurchases: false, showFollowing: true },
  store: { prices: DEFAULT_PRICES, offered: { lease: true, premium: true, trackout: true, exclusive: true }, freeDownloads: false },
  autoPostBeats: true,
};

export class KartaDB extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  /** The worker reaches this object over Rork's DO router: POST /op { op, token, args }. */
  async fetch(req: Request): Promise<Response> {
    if (!isInternal(req) || req.method !== 'POST') return new Response('Forbidden', { status: 403 });
    const { op, token, args } = (await req.json()) as { op: string; token: string | null; args: Args };
    return Response.json(await this.api(op, token, args ?? {}));
  }

  private get web(): string { return (this.env.WEB_URL ?? 'https://karta.strdm.io').replace(/\/$/, ''); }

  /** Single entry point, like strdm-live's platform ops: the worker routes, the object decides. */
  async api(op: string, token: string | null, args: Args): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
    try {
      const viewer = await this.viewer(token);
      const fn = (this as unknown as Record<string, (v: Viewer, a: Args) => unknown>)[`op_${op}`];
      if (typeof fn !== 'function') throw new ApiError(404, 'Not found');
      return { ok: true, data: await fn.call(this, viewer, args) };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message };
      console.error(`[db] ${op} failed`, e);
      return { ok: false, status: 500, error: 'Something went wrong. Try again.' };
    }
  }

  /* ---------------- helpers ---------------- */
  private one(q: string, ...p: SqlStorageValue[]): Row | undefined { return this.sql.exec(q, ...p).toArray()[0] as Row | undefined; }
  private all(q: string, ...p: SqlStorageValue[]): Row[] { return this.sql.exec(q, ...p).toArray() as Row[]; }
  private need(v: Viewer, role?: Role): NonNullable<Viewer> {
    if (!v) throw new ApiError(401, 'Sign in to continue.');
    if (role && v.role !== role) throw new ApiError(403, role === 'producer' ? 'Only producer accounts can do that.' : 'Only buyer accounts can do that.');
    return v;
  }

  private async viewer(token: string | null): Promise<Viewer> {
    if (!token) return null;
    const s = this.one('SELECT s.user_id, s.expires_at, u.role, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', await sha256Hex(token));
    if (!s || Number(s.expires_at) < Date.now()) return null;
    return { id: String(s.user_id), role: s.role as Role, email: String(s.email) };
  }

  private settings(userId: string): typeof DEFAULT_SETTINGS {
    const r = this.one('SELECT settings FROM profiles WHERE user_id = ?', userId);
    const s = r ? JSON.parse(String(r.settings)) : {};
    return {
      ...DEFAULT_SETTINGS, ...s,
      notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications ?? {}) },
      privacy: { ...DEFAULT_SETTINGS.privacy, ...(s.privacy ?? {}) },
      store: { ...DEFAULT_SETTINGS.store, ...(s.store ?? {}), prices: { ...DEFAULT_PRICES, ...(s.store?.prices ?? {}) }, offered: { ...DEFAULT_SETTINGS.store.offered, ...(s.store?.offered ?? {}) } },
    };
  }

  private profileCard(userId: string): Record<string, unknown> | null {
    const p = this.one('SELECT p.*, u.role FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?', userId);
    if (!p) return null;
    return { id: p.user_id, handle: p.handle, name: p.name, avatar: p.avatar, role: p.role };
  }

  private beatOut(b: Row, viewer: Viewer): Record<string, unknown> {
    const files = JSON.parse(String(b.files)) as Record<string, string>;
    const prices = JSON.parse(String(b.prices)) as Partial<Record<LicenseId, number>>;
    const art = JSON.parse(String(b.art)) as Record<string, string>;
    const fav = viewer ? !!this.one('SELECT 1 FROM favorites WHERE user_id = ? AND beat_id = ?', viewer.id, String(b.id)) : false;
    const mine = viewer?.id === b.producer_id;
    return {
      id: b.id, title: b.title, bpm: b.bpm, key: b.musical_key, genre: b.genre, tags: JSON.parse(String(b.tags)), description: b.description,
      status: b.status, prices, plays: b.plays, createdAt: b.created_at, publishedAt: b.published_at,
      cover: files.cover ? `/media/beats/${b.id}/cover?v=${b.published_at || b.created_at}` : '',
      preview: files.preview ? `/media/beats/${b.id}/preview` : '',
      art: Object.fromEntries(Object.keys(art).map((k) => [k, `/media/beats/${b.id}/${k}`])),
      producer: this.profileCard(String(b.producer_id)),
      favorited: fav,
      ...(mine ? { files: Object.keys(files), soldTo: b.sold_to } : {}),
    };
  }

  /* ---------------- auth ---------------- */
  private async hashPassword(password: string, salt: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private async newSession(userId: string): Promise<string> {
    const token = randomToken();
    this.sql.exec('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256Hex(token), userId, Date.now() + SESSION_DAYS * DAY);
    return token;
  }

  async op_signup(_: Viewer, a: Args) {
    const email = text(a.email, 200).toLowerCase();
    const password = typeof a.password === 'string' ? a.password : '';
    const role: Role = a.role === 'producer' ? 'producer' : 'buyer';
    const name = text(a.name, 60);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.');
    if (password.length < 8) throw new ApiError(400, 'Use a password of at least 8 characters.');
    if (!name) throw new ApiError(400, 'Add your name or producer name.');
    const handle = cleanHandle(a.handle);
    if (this.one('SELECT 1 FROM users WHERE email = ?', email)) throw new ApiError(409, 'An account with that email already exists. Sign in instead.');
    if (this.one('SELECT 1 FROM profiles WHERE handle = ?', handle)) throw new ApiError(409, `@${handle} is taken.`);
    const id = uid('u_'), salt = randomToken(16), now = Date.now();
    this.sql.exec('INSERT INTO users (id, email, pass_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, email, await this.hashPassword(password, salt), salt, role, now);
    this.sql.exec('INSERT INTO profiles (user_id, handle, name, settings, updated_at) VALUES (?, ?, ?, ?, ?)', id, handle, name, JSON.stringify(DEFAULT_SETTINGS), now);
    return { token: await this.newSession(id), me: this.op_me({ id, role, email }) };
  }

  async op_login(_: Viewer, a: Args) {
    const email = text(a.email, 200).toLowerCase();
    const u = this.one('SELECT * FROM users WHERE email = ?', email);
    if (u?.pass_hash === '!strdm') throw new ApiError(401, 'This account signs in with STRDM. Use “Continue with STRDM”.');
    if (!u || (await this.hashPassword(String(a.password ?? ''), String(u.salt))) !== u.pass_hash) throw new ApiError(401, 'That email and password don’t match.');
    const v = { id: String(u.id), role: u.role as Role, email };
    return { token: await this.newSession(v.id), me: this.op_me(v) };
  }

  async op_logout(_: Viewer, a: Args) {
    if (typeof a.token === 'string') this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(a.token));
    return { ok: true };
  }

  op_me(v: Viewer) {
    const me = this.need(v);
    const p = this.one('SELECT * FROM profiles WHERE user_id = ?', me.id)!;
    return {
      id: me.id, email: me.email, role: me.role, handle: p.handle, name: p.name, bio: p.bio, avatar: p.avatar, banner: p.banner,
      location: p.location, genres: JSON.parse(String(p.genres)), links: JSON.parse(String(p.links)), settings: this.settings(me.id),
      payouts: { connected: !!p.stripe_account, ready: !!p.payouts_ready },
    };
  }

  /* ---------------- profiles & settings ---------------- */
  op_updateProfile(v: Viewer, a: Args) {
    const me = this.need(v);
    const cur = this.one('SELECT * FROM profiles WHERE user_id = ?', me.id)!;
    let handle = String(cur.handle);
    if (a.handle !== undefined && a.handle !== handle) {
      handle = cleanHandle(a.handle);
      if (this.one('SELECT 1 FROM profiles WHERE handle = ? AND user_id != ?', handle, me.id)) throw new ApiError(409, `@${handle} is taken.`);
    }
    const links = a.links && typeof a.links === 'object' ? a.links as Record<string, unknown> : JSON.parse(String(cur.links));
    const cleanLinks = Object.fromEntries(['instagram', 'youtube', 'tiktok', 'x', 'website', 'beatstars'].map((k) => [k, text(links[k], 200)]).filter(([, v]) => v));
    const genres = Array.isArray(a.genres) ? a.genres.map((g) => text(g, 30)).filter(Boolean).slice(0, 8) : JSON.parse(String(cur.genres));
    const s = this.settings(me.id);
    const ns = (a.settings && typeof a.settings === 'object' ? a.settings : {}) as Partial<typeof DEFAULT_SETTINGS>;
    const prices = { ...s.store.prices } as Record<LicenseId, number>;
    if (ns.store?.prices) for (const id of LICENSE_IDS) if (ns.store.prices[id] !== undefined) prices[id] = cents(ns.store.prices[id], { min: 0, max: 5_000_000 });
    const offered = { ...s.store.offered } as Record<LicenseId, boolean>;
    if (ns.store?.offered) for (const id of LICENSE_IDS) if (ns.store.offered[id] !== undefined) offered[id] = !!ns.store.offered[id];
    const settings = {
      notifications: { ...s.notifications, ...pickBools(ns.notifications, Object.keys(s.notifications)) },
      privacy: { ...s.privacy, ...pickBools(ns.privacy, Object.keys(s.privacy)) },
      store: { prices, offered, freeDownloads: ns.store?.freeDownloads !== undefined ? !!ns.store.freeDownloads : s.store.freeDownloads },
      autoPostBeats: ns.autoPostBeats !== undefined ? !!ns.autoPostBeats : s.autoPostBeats,
    };
    this.sql.exec(
      'UPDATE profiles SET handle = ?, name = ?, bio = ?, location = ?, genres = ?, links = ?, settings = ?, updated_at = ? WHERE user_id = ?',
      handle, a.name !== undefined ? text(a.name, 60) || String(cur.name) : String(cur.name), a.bio !== undefined ? multiline(a.bio, 400) : String(cur.bio),
      a.location !== undefined ? text(a.location, 80) : String(cur.location), JSON.stringify(genres), JSON.stringify(cleanLinks), JSON.stringify(settings), Date.now(), me.id,
    );
    return this.op_me(me);
  }

  /** Called by the worker after it stores an avatar/banner in R2. */
  op_setProfileImage(v: Viewer, a: Args) {
    const me = this.need(v);
    const col = a.kind === 'banner' ? 'banner' : 'avatar';
    this.sql.exec(`UPDATE profiles SET ${col} = ?, updated_at = ? WHERE user_id = ?`, `/media/profiles/${me.id}/${col}?v=${Date.now()}`, Date.now(), me.id);
    return this.op_me(me);
  }

  async op_changePassword(v: Viewer, a: Args) {
    const me = this.need(v);
    const u = this.one('SELECT * FROM users WHERE id = ?', me.id)!;
    if (u.pass_hash !== '!strdm' && (await this.hashPassword(String(a.current ?? ''), String(u.salt))) !== u.pass_hash) throw new ApiError(400, 'Your current password is wrong.');
    const next = String(a.next ?? '');
    if (next.length < 8) throw new ApiError(400, 'Use a password of at least 8 characters.');
    const salt = randomToken(16);
    this.sql.exec('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', await this.hashPassword(next, salt), salt, me.id);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', me.id);
    return { token: await this.newSession(me.id) };
  }

  op_profile(v: Viewer, a: Args) {
    const handle = text(a.handle, 30).toLowerCase().replace(/^@/, '');
    const p = this.one('SELECT p.*, u.role FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.handle = ?', handle);
    if (!p) throw new ApiError(404, `There’s no one at @${handle}.`);
    const id = String(p.user_id);
    const s = this.settings(id);
    const count = (q: string, ...x: SqlStorageValue[]) => Number(this.one(q, ...x)?.n ?? 0);
    const out: Record<string, unknown> = {
      id, handle: p.handle, name: p.name, bio: p.bio, avatar: p.avatar, banner: p.banner, location: p.location, role: p.role,
      genres: JSON.parse(String(p.genres)), links: JSON.parse(String(p.links)),
      followers: count('SELECT COUNT(*) n FROM follows WHERE followee = ?', id),
      following: count('SELECT COUNT(*) n FROM follows WHERE follower = ?', id),
      followedByMe: v ? !!this.one('SELECT 1 FROM follows WHERE follower = ? AND followee = ?', v.id, id) : false,
      isMe: v?.id === id,
    };
    if (p.role === 'producer') {
      out.beats = this.all("SELECT * FROM beats WHERE producer_id = ? AND status = 'live' ORDER BY published_at DESC", id).map((b) => this.beatOut(b, v));
      out.stats = {
        beats: (out.beats as unknown[]).length,
        plays: count("SELECT COALESCE(SUM(plays),0) n FROM beats WHERE producer_id = ?", id),
        sales: count("SELECT COUNT(*) n FROM orders WHERE producer_id = ? AND status = 'paid'", id),
      };
      out.offered = Object.fromEntries(LICENSE_IDS.filter((l) => s.store.offered[l]).map((l) => [l, { ...LICENSES[l], price: s.store.prices[l] }]));
      out.payoutsReady = !!p.payouts_ready;
    } else {
      out.stats = { purchases: count("SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND status = 'paid'", id), favorites: count('SELECT COUNT(*) n FROM favorites WHERE user_id = ?', id) };
      if (s.privacy.showPurchases || v?.id === id) {
        out.collection = this.all("SELECT DISTINCT b.* FROM orders o JOIN beats b ON b.id = o.beat_id WHERE o.buyer_id = ? AND o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 50", id).map((b) => this.beatOut(b, v));
      }
    }
    return out;
  }

  op_follow(v: Viewer, a: Args) {
    const me = this.need(v);
    const target = this.one('SELECT user_id FROM profiles WHERE handle = ?', text(a.handle, 30).toLowerCase());
    if (!target) throw new ApiError(404, 'That account doesn’t exist.');
    if (target.user_id === me.id) throw new ApiError(400, 'You can’t follow yourself.');
    if (a.on === false) this.sql.exec('DELETE FROM follows WHERE follower = ? AND followee = ?', me.id, String(target.user_id));
    else this.sql.exec('INSERT OR IGNORE INTO follows (follower, followee, created_at) VALUES (?, ?, ?)', me.id, String(target.user_id), Date.now());
    return { following: a.on !== false };
  }

  /* ---------------- beats (producer) ---------------- */
  op_createBeat(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const title = text(a.title, 80);
    if (!title) throw new ApiError(400, 'Give the beat a title.');
    const id = uid('b_');
    this.sql.exec(
      'INSERT INTO beats (id, producer_id, title, bpm, musical_key, genre, tags, description, prices, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, me.id, title, Math.max(0, Math.min(300, Math.round(Number(a.bpm) || 0))), text(a.key, 8), text(a.genre, 30),
      JSON.stringify(Array.isArray(a.tags) ? a.tags.map((t) => text(t, 30)).filter(Boolean).slice(0, 10) : []), multiline(a.description, 1000),
      JSON.stringify(this.cleanPrices(a.prices)), Date.now(),
    );
    return this.beatOut(this.one('SELECT * FROM beats WHERE id = ?', id)!, me);
  }

  private cleanPrices(p: unknown): Partial<Record<LicenseId, number>> {
    if (!p || typeof p !== 'object') return {};
    const o: Partial<Record<LicenseId, number>> = {};
    for (const id of LICENSE_IDS) { const v = (p as Record<string, unknown>)[id]; if (v !== undefined && v !== null && v !== '') o[id] = cents(v, { max: 5_000_000 }); }
    return o;
  }

  private ownBeat(me: NonNullable<Viewer>, id: unknown): Row {
    const b = this.one('SELECT * FROM beats WHERE id = ?', text(id, 40));
    if (!b || b.producer_id !== me.id) throw new ApiError(404, 'Beat not found.');
    return b;
  }

  op_updateBeat(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    if (b.status === 'sold') throw new ApiError(400, 'This beat sold exclusive and can’t be edited.');
    const set = (col: string, val: SqlStorageValue) => this.sql.exec(`UPDATE beats SET ${col} = ? WHERE id = ?`, val, String(b.id));
    if (a.title !== undefined) set('title', text(a.title, 80) || String(b.title));
    if (a.bpm !== undefined) set('bpm', Math.max(0, Math.min(300, Math.round(Number(a.bpm) || 0))));
    if (a.key !== undefined) set('musical_key', text(a.key, 8));
    if (a.genre !== undefined) set('genre', text(a.genre, 30));
    if (Array.isArray(a.tags)) set('tags', JSON.stringify(a.tags.map((t) => text(t, 30)).filter(Boolean).slice(0, 10)));
    if (a.description !== undefined) set('description', multiline(a.description, 1000));
    if (a.prices !== undefined) set('prices', JSON.stringify(this.cleanPrices(a.prices)));
    return this.beatOut(this.one('SELECT * FROM beats WHERE id = ?', String(b.id))!, me);
  }

  /** The worker asks before writing to R2, so only the owner can upload, and only known kinds. */
  op_authorizeUpload(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    const kind = text(a.kind, 10);
    if (!['preview', 'mp3', 'wav', 'stems', 'cover'].includes(kind)) throw new ApiError(400, 'Upload a preview, mp3, wav, stems or cover.');
    if (b.status === 'sold') throw new ApiError(400, 'This beat sold exclusive.');
    return { key: `beats/${b.id}/${kind}` };
  }

  op_fileUploaded(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    const files = JSON.parse(String(b.files));
    files[text(a.kind, 10)] = text(a.key, 200);
    this.sql.exec('UPDATE beats SET files = ? WHERE id = ?', JSON.stringify(files), String(b.id));
    return this.beatOut(this.one('SELECT * FROM beats WHERE id = ?', String(b.id))!, me);
  }

  op_publishBeat(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    if (b.status === 'sold') throw new ApiError(400, 'This beat sold exclusive.');
    const files = JSON.parse(String(b.files));
    if (a.live === false) {
      this.sql.exec("UPDATE beats SET status = 'draft' WHERE id = ?", String(b.id));
    } else {
      const missing = ['preview', 'mp3'].filter((k) => !files[k]);
      if (missing.length) throw new ApiError(400, `Upload the ${missing.join(' and ')} before publishing.`);
      const first = !Number(b.published_at);
      this.sql.exec("UPDATE beats SET status = 'live', published_at = CASE WHEN published_at = 0 THEN ? ELSE published_at END WHERE id = ?", Date.now(), String(b.id));
      if (first && this.settings(me.id).autoPostBeats) {
        this.sql.exec("INSERT INTO posts (id, owner, kind, beat_id, caption, created_at) VALUES (?, ?, 'beat', ?, ?, ?)", uid('p_'), me.id, String(b.id), text(a.caption, 500), Date.now());
      }
    }
    return this.beatOut(this.one('SELECT * FROM beats WHERE id = ?', String(b.id))!, me);
  }

  op_deleteBeat(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    if (this.one("SELECT 1 FROM orders WHERE beat_id = ? AND status = 'paid'", String(b.id))) throw new ApiError(400, 'This beat has sales, so it can’t be deleted. Unpublish it instead.');
    this.sql.exec('DELETE FROM beats WHERE id = ?', String(b.id));
    this.sql.exec('DELETE FROM posts WHERE beat_id = ?', String(b.id));
    return { ok: true, files: Object.values(JSON.parse(String(b.files))) };
  }

  op_myBeats(v: Viewer) {
    const me = this.need(v, 'producer');
    return this.all('SELECT * FROM beats WHERE producer_id = ? ORDER BY created_at DESC', me.id).map((b) => ({
      ...this.beatOut(b, me),
      sales: Number(this.one("SELECT COUNT(*) n FROM orders WHERE beat_id = ? AND status = 'paid'", String(b.id))?.n ?? 0),
    }));
  }

  op_mySales(v: Viewer) {
    const me = this.need(v, 'producer');
    const rows = this.all("SELECT o.*, b.title FROM orders o JOIN beats b ON b.id = o.beat_id WHERE o.producer_id = ? AND o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 200", me.id);
    const gross = rows.reduce((s, r) => s + Number(r.amount_cents), 0), fees = rows.reduce((s, r) => s + Number(r.fee_cents), 0);
    const since = Date.now() - 30 * DAY;
    return {
      totals: { gross, fees, net: gross - fees, count: rows.length, last30: rows.filter((r) => Number(r.paid_at) > since).reduce((s, r) => s + Number(r.amount_cents) - Number(r.fee_cents), 0), exclusives: rows.filter((r) => r.license === 'exclusive').length },
      orders: rows.map((r) => ({ id: r.id, beat: r.title, beatId: r.beat_id, license: r.license, amount: r.amount_cents, fee: r.fee_cents, buyer: this.profileCard(String(r.buyer_id)) ?? { name: String(r.buyer_email).split('@')[0] }, paidAt: r.paid_at })),
    };
  }

  /* ---------------- store (public) ---------------- */
  op_store(v: Viewer, a: Args) {
    const where = ["b.status = 'live'"], p: SqlStorageValue[] = [];
    const q = text(a.q, 60).toLowerCase();
    if (q) { where.push("(LOWER(b.title) LIKE ? OR LOWER(b.tags) LIKE ? OR LOWER(pr.name) LIKE ? OR pr.handle LIKE ?)"); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (text(a.genre, 30)) { where.push('LOWER(b.genre) = ?'); p.push(text(a.genre, 30).toLowerCase()); }
    if (text(a.key, 8)) { where.push('b.musical_key = ?'); p.push(text(a.key, 8)); }
    if (Number(a.bpmMin)) { where.push('b.bpm >= ?'); p.push(Number(a.bpmMin)); }
    if (Number(a.bpmMax)) { where.push('b.bpm <= ?'); p.push(Number(a.bpmMax)); }
    if (text(a.producer, 30)) { where.push('pr.handle = ?'); p.push(text(a.producer, 30).toLowerCase()); }
    const order = a.sort === 'popular' ? 'b.plays DESC' : 'b.published_at DESC';
    const offset = Math.max(0, Math.round(Number(a.offset) || 0));
    const rows = this.all(`SELECT b.* FROM beats b JOIN profiles pr ON pr.user_id = b.producer_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${PAGE + 1} OFFSET ${offset}`, ...p);
    const genres = this.all("SELECT genre, COUNT(*) n FROM beats WHERE status = 'live' AND genre != '' GROUP BY LOWER(genre) ORDER BY n DESC LIMIT 12").map((r) => r.genre);
    return { beats: rows.slice(0, PAGE).map((b) => this.withPrices(this.beatOut(b, v), String(b.producer_id))), more: rows.length > PAGE, genres };
  }

  /** Effective prices: per-beat override, else the producer's store prices; only licenses they offer. */
  private withPrices(beat: Record<string, unknown>, producerId: string) {
    const s = this.settings(producerId);
    const own = beat.prices as Partial<Record<LicenseId, number>>;
    const offers = LICENSE_IDS.filter((l) => s.store.offered[l]).map((l) => ({ id: l, ...LICENSES[l], price: own[l] ?? s.store.prices[l] })).filter((o) => o.price > 0);
    return { ...beat, offers, from: offers.length ? Math.min(...offers.map((o) => o.price)) : 0 };
  }

  op_beat(v: Viewer, a: Args) {
    const b = this.one('SELECT * FROM beats WHERE id = ?', text(a.id, 40));
    if (!b || (b.status === 'draft' && v?.id !== b.producer_id)) throw new ApiError(404, 'That beat isn’t available.');
    const more = this.all("SELECT * FROM beats WHERE producer_id = ? AND status = 'live' AND id != ? ORDER BY published_at DESC LIMIT 6", String(b.producer_id), String(b.id));
    const owned = v ? this.all("SELECT license FROM orders WHERE buyer_id = ? AND beat_id = ? AND status = 'paid'", v.id, String(b.id)).map((r) => r.license) : [];
    return { ...this.withPrices(this.beatOut(b, v), String(b.producer_id)), owned, moreFromProducer: more.map((m) => this.withPrices(this.beatOut(m, v), String(m.producer_id))) };
  }

  op_play(_: Viewer, a: Args) {
    this.sql.exec("UPDATE beats SET plays = plays + 1 WHERE id = ? AND status != 'draft'", text(a.id, 40));
    return { ok: true };
  }

  op_mediaKey(v: Viewer, a: Args) {
    // public media: previews, covers and generated art of non-draft beats; profile images
    const kind = text(a.kind, 20);
    if (a.scope === 'live') return { key: `live/${text(a.id, 40)}/${text(a.kind, 80)}` };
    if (a.scope === 'profiles') {
      const col = kind === 'banner' ? 'banner' : 'avatar';
      const p = this.one(`SELECT ${col} AS v FROM profiles WHERE user_id = ?`, text(a.id, 40));
      if (!p?.v) throw new ApiError(404, 'Not found');
      return { key: `profiles/${text(a.id, 40)}/${col}` };
    }
    const b = this.one('SELECT producer_id, status, files, art FROM beats WHERE id = ?', text(a.id, 40));
    if (!b) throw new ApiError(404, 'Not found');
    if (b.status === 'draft' && v?.id !== b.producer_id) throw new ApiError(404, 'Not found');
    const files = JSON.parse(String(b.files)), art = JSON.parse(String(b.art));
    const key = kind === 'preview' || kind === 'cover' ? files[kind] : art[kind];
    if (!key) throw new ApiError(404, 'Not found');
    return { key };
  }

  /* ---------------- buyers ---------------- */
  op_favorite(v: Viewer, a: Args) {
    const me = this.need(v);
    const id = text(a.id, 40);
    if (!this.one('SELECT 1 FROM beats WHERE id = ?', id)) throw new ApiError(404, 'Beat not found.');
    if (a.on === false) this.sql.exec('DELETE FROM favorites WHERE user_id = ? AND beat_id = ?', me.id, id);
    else this.sql.exec('INSERT OR IGNORE INTO favorites (user_id, beat_id, created_at) VALUES (?, ?, ?)', me.id, id, Date.now());
    return { favorited: a.on !== false };
  }

  op_library(v: Viewer) {
    const me = this.need(v);
    const lic = this.all("SELECT l.*, o.amount_cents, o.paid_at FROM licenses l JOIN orders o ON o.id = l.order_id WHERE l.buyer_id = ? ORDER BY o.paid_at DESC", me.id);
    const purchases = lic.map((l) => {
      const b = this.one('SELECT * FROM beats WHERE id = ?', String(l.beat_id));
      const kinds = LICENSES[l.license as LicenseId].files;
      const files = b ? JSON.parse(String(b.files)) as Record<string, string> : {};
      return {
        id: l.id, license: l.license, licenseName: LICENSES[l.license as LicenseId].name, terms: LICENSES[l.license as LicenseId].terms,
        amount: l.amount_cents, paidAt: l.paid_at, downloads: l.downloads,
        beat: b ? this.beatOut(b, me) : null,
        files: kinds.filter((k) => files[k]).map((k) => ({ kind: k, url: `/dl/${l.token}/${k}` })),
        agreement: `/dl/${l.token}/license`,
      };
    });
    const favorites = this.all('SELECT b.* FROM favorites f JOIN beats b ON b.id = f.beat_id WHERE f.user_id = ? ORDER BY f.created_at DESC', me.id)
      .map((b) => this.withPrices(this.beatOut(b, me), String(b.producer_id)));
    const following = this.all('SELECT followee FROM follows WHERE follower = ? ORDER BY created_at DESC', me.id).map((r) => this.profileCard(String(r.followee)));
    return { purchases, favorites, following };
  }

  async op_resolveDownload(_: Viewer, a: Args) {
    const l = this.one('SELECT * FROM licenses WHERE token_hash = ?', await sha256Hex(text(a.token, 200)));
    if (!l) throw new ApiError(404, 'This download link isn’t valid.');
    const b = this.one('SELECT * FROM beats WHERE id = ?', String(l.beat_id));
    if (!b) throw new ApiError(410, 'The producer removed this beat.');
    const kind = text(a.kind, 10);
    const lic = LICENSES[l.license as LicenseId];
    const buyer = this.one('SELECT name FROM profiles WHERE user_id = ?', String(l.buyer_id));
    const producer = this.one('SELECT name FROM profiles WHERE user_id = ?', String(b.producer_id));
    if (kind === 'license') {
      return { agreement: licenseText({ beat: String(b.title), producer: String(producer?.name ?? ''), buyer: String(buyer?.name ?? ''), license: l.license as LicenseId, date: Number(l.created_at), id: String(l.id) }) };
    }
    if (!lic.files.includes(kind as FileKind)) throw new ApiError(403, `Your ${lic.name} doesn’t include ${kind.toUpperCase()} files.`);
    const key = JSON.parse(String(b.files))[kind];
    if (!key) throw new ApiError(404, 'The producer hasn’t uploaded that file yet.');
    this.sql.exec('UPDATE licenses SET downloads = downloads + 1 WHERE id = ?', String(l.id));
    return { key, filename: `${String(b.title).replace(/[^\w\- ]+/g, '')} (${lic.name}).${kind === 'stems' ? 'zip' : kind}` };
  }

  /* ---------------- payments: Stripe Connect ---------------- */
  async op_payoutsLink(v: Viewer) {
    const me = this.need(v, 'producer');
    const p = this.one('SELECT stripe_account FROM profiles WHERE user_id = ?', me.id)!;
    let acct = String(p.stripe_account);
    if (!acct) {
      const created = await stripe<{ id: string }>(this.env.STRIPE_SECRET_KEY, 'POST', '/v1/accounts', {
        type: 'express', email: me.email, 'capabilities[card_payments][requested]': true, 'capabilities[transfers][requested]': true,
        'business_profile[product_description]': 'Beat licenses sold on Karta', 'metadata[karta_user]': me.id,
      });
      acct = created.id;
      this.sql.exec('UPDATE profiles SET stripe_account = ? WHERE user_id = ?', acct, me.id);
    }
    const link = await stripe<{ url: string }>(this.env.STRIPE_SECRET_KEY, 'POST', '/v1/account_links', {
      account: acct, type: 'account_onboarding', refresh_url: `${this.web}/settings?tab=payouts`, return_url: `${this.web}/settings?tab=payouts&done=1`,
    });
    return { url: link.url };
  }

  async op_payoutsStatus(v: Viewer) {
    const me = this.need(v, 'producer');
    const p = this.one('SELECT stripe_account FROM profiles WHERE user_id = ?', me.id)!;
    if (!p.stripe_account) return { connected: false, ready: false };
    const a = await stripe<{ charges_enabled?: boolean; payouts_enabled?: boolean; requirements?: { currently_due?: string[] } }>(this.env.STRIPE_SECRET_KEY, 'GET', `/v1/accounts/${p.stripe_account}`);
    const ready = !!a.charges_enabled && !!a.payouts_enabled;
    this.sql.exec('UPDATE profiles SET payouts_ready = ? WHERE user_id = ?', ready ? 1 : 0, me.id);
    return { connected: true, ready, due: a.requirements?.currently_due ?? [] };
  }

  async op_dashboardLink(v: Viewer) {
    const me = this.need(v, 'producer');
    const p = this.one('SELECT stripe_account FROM profiles WHERE user_id = ?', me.id)!;
    if (!p.stripe_account) throw new ApiError(400, 'Set up payouts first.');
    return { url: (await stripe<{ url: string }>(this.env.STRIPE_SECRET_KEY, 'POST', `/v1/accounts/${p.stripe_account}/login_links`)).url };
  }

  /** Prices come from the catalog, never from the request. The producer is paid through Connect. */
  async op_checkout(v: Viewer, a: Args) {
    const me = this.need(v);
    const b = this.one('SELECT * FROM beats WHERE id = ?', text(a.beatId, 40));
    if (!b || b.status !== 'live') throw new ApiError(404, b?.status === 'sold' ? 'This beat sold exclusive.' : 'That beat isn’t for sale.');
    if (b.producer_id === me.id) throw new ApiError(400, 'You can’t buy your own beat.');
    const license = text(a.license, 12) as LicenseId;
    const beat = this.withPrices(this.beatOut(b, me), String(b.producer_id));
    const offer = (beat.offers as { id: LicenseId; price: number; name: string }[]).find((o) => o.id === license);
    if (!offer) throw new ApiError(400, 'That license isn’t offered for this beat.');
    if (this.one("SELECT 1 FROM orders WHERE buyer_id = ? AND beat_id = ? AND license = ? AND status = 'paid'", me.id, String(b.id), license)) throw new ApiError(400, 'You already own this license. Find it in your Library.');
    const prod = this.one('SELECT stripe_account, payouts_ready, name FROM profiles WHERE user_id = ?', String(b.producer_id))!;
    if (!prod.stripe_account || !prod.payouts_ready) throw new ApiError(400, `${prod.name} hasn’t finished setting up payouts, so this beat can’t be bought yet.`);
    const fee = Math.round((offer.price * Number(this.env.PLATFORM_FEE_BPS ?? '1000')) / 10_000);
    const orderId = uid('o_');
    const session = await stripe<{ id: string; url: string }>(this.env.STRIPE_SECRET_KEY, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', customer_email: me.email, client_reference_id: orderId,
      'line_items[0][quantity]': 1, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': offer.price,
      'line_items[0][price_data][product_data][name]': `${b.title} · ${offer.name}`,
      'line_items[0][price_data][product_data][description]': LICENSES[license].terms,
      'payment_intent_data[application_fee_amount]': fee,
      'payment_intent_data[transfer_data][destination]': String(prod.stripe_account),
      'metadata[order_id]': orderId,
      success_url: `${this.web}/library?paid=${orderId}`, cancel_url: `${this.web}/beat/${b.id}`,
    });
    this.sql.exec(
      "INSERT INTO orders (id, buyer_id, buyer_email, beat_id, producer_id, license, amount_cents, fee_cents, status, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      orderId, me.id, me.email, String(b.id), String(b.producer_id), license, offer.price, fee, session.id, Date.now(),
    );
    return { url: session.url, orderId };
  }

  /** Webhook events (signature already verified by the worker). */
  async op_stripeEvent(_: Viewer, a: Args) {
    const ev = a.event as { type: string; data: { object: Record<string, unknown> } };
    const o = ev.data.object;
    if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid') {
      const orderId = String((o.metadata as Record<string, string> | undefined)?.order_id ?? o.client_reference_id ?? '');
      return this.fulfil(orderId);
    }
    if (ev.type === 'account.updated') {
      const ready = !!o.charges_enabled && !!o.payouts_enabled;
      this.sql.exec('UPDATE profiles SET payouts_ready = ? WHERE stripe_account = ?', ready ? 1 : 0, String(o.id));
      return { ok: true };
    }
    return { ok: true, ignored: ev.type };
  }

  private async fulfil(orderId: string) {
    const order = this.one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) return { ok: false, error: 'unknown order' };
    if (order.status === 'paid') return { ok: true, duplicate: true };
    const beat = this.one('SELECT * FROM beats WHERE id = ?', String(order.beat_id));
    const now = Date.now();
    this.sql.exec("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?", now, orderId);
    const token = randomToken(24);
    // the token is kept so the buyer can reopen downloads from their Library; links resolve against the hash
    this.sql.exec('INSERT INTO licenses (id, order_id, buyer_id, beat_id, license, token_hash, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid('l_'), orderId, String(order.buyer_id), String(order.beat_id), String(order.license), await sha256Hex(token), token, now);
    if (order.license === 'exclusive' && beat) {
      // exclusive: beat leaves the store everywhere, other pending checkouts for it are void
      const buyer = this.one('SELECT name FROM profiles WHERE user_id = ?', String(order.buyer_id));
      this.sql.exec("UPDATE beats SET status = 'sold', sold_to = ? WHERE id = ?", String(buyer?.name ?? order.buyer_email), String(beat.id));
      this.sql.exec("UPDATE orders SET status = 'void' WHERE beat_id = ? AND status = 'pending'", String(beat.id));
      this.sql.exec('UPDATE posts SET hidden = 1 WHERE beat_id = ?', String(beat.id));
      this.sql.exec('DELETE FROM favorites WHERE beat_id = ?', String(beat.id));
    }
    return { ok: true, orderId, license: order.license };
  }

  /* ---------------- feed (ported from strdm-live fan social) ---------------- */
  op_feed(v: Viewer, a: Args) {
    const before = Number(a.before) || Date.now() + 1;
    const where = ['p.hidden = 0', 'p.created_at < ?'], params: SqlStorageValue[] = [before];
    if (a.scope === 'following') {
      const me = this.need(v);
      where.push('(p.owner IN (SELECT followee FROM follows WHERE follower = ?) OR p.owner = ?)'); params.push(me.id, me.id);
    } else if (a.scope === 'user') {
      const u = this.one('SELECT user_id FROM profiles WHERE handle = ?', text(a.handle, 30).toLowerCase());
      if (!u) throw new ApiError(404, 'That account doesn’t exist.');
      where.push('p.owner = ?'); params.push(String(u.user_id));
    }
    const rows = this.all(`SELECT p.* FROM posts p WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ${PAGE}`, ...params);
    return { posts: rows.map((p) => this.postOut(p, v)).filter(Boolean), next: rows.length === PAGE ? Number(rows[rows.length - 1].created_at) : null };
  }

  private postOut(p: Row, v: Viewer): Record<string, unknown> | null {
    const orig = p.kind === 'repost' ? this.one('SELECT * FROM posts WHERE id = ? AND hidden = 0', String(p.repost_of)) : null;
    if (p.kind === 'repost' && !orig) return null;
    const base = orig ?? p;
    const b = base.beat_id ? this.one('SELECT * FROM beats WHERE id = ?', String(base.beat_id)) : null;
    const id = String(base.id);
    return {
      id: p.id, kind: base.kind, createdAt: p.created_at, caption: base.caption,
      author: this.profileCard(String(base.owner)),
      repostedBy: orig ? this.profileCard(String(p.owner)) : null,
      beat: b && b.status === 'live' ? this.withPrices(this.beatOut(b, v), String(b.producer_id)) : null,
      likes: Number(this.one('SELECT COUNT(*) n FROM post_likes WHERE post_id = ?', id)?.n ?? 0),
      reposts: Number(this.one("SELECT COUNT(*) n FROM posts WHERE repost_of = ? AND hidden = 0", id)?.n ?? 0),
      liked: v ? !!this.one('SELECT 1 FROM post_likes WHERE post_id = ? AND owner = ?', id, v.id) : false,
      mine: v?.id === p.owner,
      targetId: id,
    };
  }

  op_createPost(v: Viewer, a: Args) {
    const me = this.need(v);
    const caption = multiline(a.caption, 500);
    let beatId = '';
    if (a.beatId) {
      const b = this.one("SELECT * FROM beats WHERE id = ? AND status = 'live'", text(a.beatId, 40));
      if (!b) throw new ApiError(400, 'That beat isn’t live.');
      beatId = String(b.id);
    }
    if (!caption && !beatId) throw new ApiError(400, 'Write something or attach a beat.');
    const id = uid('p_');
    this.sql.exec('INSERT INTO posts (id, owner, kind, beat_id, caption, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, me.id, beatId ? 'beat' : 'text', beatId, caption, Date.now());
    return this.postOut(this.one('SELECT * FROM posts WHERE id = ?', id)!, me);
  }

  op_likePost(v: Viewer, a: Args) {
    const me = this.need(v);
    const id = text(a.id, 40);
    if (!this.one('SELECT 1 FROM posts WHERE id = ? AND hidden = 0', id)) throw new ApiError(404, 'That post is gone.');
    if (a.on === false) this.sql.exec('DELETE FROM post_likes WHERE post_id = ? AND owner = ?', id, me.id);
    else this.sql.exec('INSERT OR IGNORE INTO post_likes (post_id, owner, created_at) VALUES (?, ?, ?)', id, me.id, Date.now());
    return { liked: a.on !== false, likes: Number(this.one('SELECT COUNT(*) n FROM post_likes WHERE post_id = ?', id)?.n ?? 0) };
  }

  op_repost(v: Viewer, a: Args) {
    const me = this.need(v);
    const id = text(a.id, 40);
    const orig = this.one("SELECT * FROM posts WHERE id = ? AND hidden = 0 AND kind != 'repost'", id);
    if (!orig) throw new ApiError(404, 'That post is gone.');
    if (a.on === false) { this.sql.exec("DELETE FROM posts WHERE owner = ? AND repost_of = ? AND kind = 'repost'", me.id, id); return { reposted: false }; }
    if (!this.one("SELECT 1 FROM posts WHERE owner = ? AND repost_of = ? AND kind = 'repost'", me.id, id)) {
      this.sql.exec("INSERT INTO posts (id, owner, kind, repost_of, created_at) VALUES (?, ?, 'repost', ?, ?)", uid('p_'), me.id, id, Date.now());
    }
    return { reposted: true };
  }

  op_deletePost(v: Viewer, a: Args) {
    const me = this.need(v);
    const p = this.one('SELECT * FROM posts WHERE id = ?', text(a.id, 40));
    if (!p || p.owner !== me.id) throw new ApiError(404, 'Post not found.');
    this.sql.exec('DELETE FROM posts WHERE id = ? OR repost_of = ?', String(p.id), String(p.id));
    this.sql.exec('DELETE FROM post_likes WHERE post_id = ?', String(p.id));
    return { ok: true };
  }

  op_search(v: Viewer, a: Args) {
    const q = text(a.q, 40).toLowerCase().replace(/^@/, '');
    if (q.length < 2) return { people: [] };
    return { people: this.all('SELECT user_id FROM profiles WHERE handle LIKE ? OR LOWER(name) LIKE ? LIMIT 10', `${q}%`, `%${q}%`).map((r) => this.profileCard(String(r.user_id))) };
  }

  /** Continue with STRDM: the worker has already checked the password with STRDM's backend. */
  async op_strdmLogin(_: Viewer, a: Args) {
    const email = text(a.email, 200).toLowerCase();
    if (!email) throw new ApiError(401, 'STRDM didn’t return an email for that account.');
    const u = this.one('SELECT * FROM users WHERE email = ?', email);
    if (u) {
      const v = { id: String(u.id), role: u.role as Role, email };
      return { token: await this.newSession(v.id), me: this.op_me(v) };
    }
    // first time on Karta: pick producer or buyer, and a handle
    const name = text(a.name, 60) || email.split('@')[0];
    if (!a.handle) {
      const suggest = name.toLowerCase().replace(/[^a-z0-9_.]+/g, '').slice(0, 24) || 'artist';
      let handle = suggest.length >= 3 ? suggest : `${suggest}${Math.floor(Math.random() * 900 + 100)}`;
      for (let i = 0; this.one('SELECT 1 FROM profiles WHERE handle = ?', handle) && i < 20; i++) handle = `${suggest}${Math.floor(Math.random() * 9000 + 1000)}`;
      return { needsProfile: true, name, suggestedHandle: handle };
    }
    const handle = cleanHandle(a.handle);
    if (this.one('SELECT 1 FROM profiles WHERE handle = ?', handle)) throw new ApiError(409, `@${handle} is taken.`);
    const role: Role = a.role === 'producer' ? 'producer' : 'buyer';
    const id = uid('u_'), now = Date.now();
    // no Karta password: this account signs in through STRDM (a password can be added in Settings later)
    this.sql.exec("INSERT INTO users (id, email, pass_hash, salt, role, created_at) VALUES (?, ?, '!strdm', '', ?, ?)", id, email, role, now);
    this.sql.exec('INSERT INTO profiles (user_id, handle, name, settings, updated_at) VALUES (?, ?, ?, ?, ?)', id, handle, name, JSON.stringify(DEFAULT_SETTINGS), now);
    return { token: await this.newSession(id), me: this.op_me({ id, role, email }) };
  }

  /* ---------------- art jobs (render server) ---------------- */
  op_startArt(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    const files = JSON.parse(String(b.files));
    const audio = files.wav ?? files.mp3 ?? files.preview;
    if (!audio) throw new ApiError(400, 'Upload the beat audio first.');
    if (!this.env.RENDER_URL) throw new ApiError(503, 'The art renderer isn’t connected yet. Set RENDER_URL.');
    const id = uid('j_');
    this.sql.exec("INSERT INTO art_jobs (id, beat_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)", id, String(b.id), Date.now(), Date.now());
    const prod = this.one('SELECT name FROM profiles WHERE user_id = ?', me.id);
    return { jobId: id, audioKey: audio, meta: { title: b.title, producer: prod?.name, genre: b.genre, bpm: b.bpm || undefined, key: b.musical_key || undefined, tags: JSON.parse(String(b.tags)) }, pattern: text(a.pattern, 10) || undefined };
  }

  op_artStatus(v: Viewer, a: Args) {
    const me = this.need(v, 'producer');
    const b = this.ownBeat(me, a.id);
    const j = this.one('SELECT * FROM art_jobs WHERE beat_id = ? ORDER BY created_at DESC LIMIT 1', String(b.id));
    return { job: j ? { id: j.id, status: j.status, error: j.error } : null, beat: this.beatOut(b, me) };
  }

  /** Render server callback (authenticated by RENDER_SECRET in the worker). */
  op_artDone(_: Viewer, a: Args) {
    const j = this.one('SELECT * FROM art_jobs WHERE id = ?', text(a.jobId, 40));
    if (!j) throw new ApiError(404, 'Unknown job');
    if (a.error) {
      this.sql.exec("UPDATE art_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", text(a.error, 300), Date.now(), String(j.id));
      return { ok: true };
    }
    const b = this.one('SELECT files, art FROM beats WHERE id = ?', String(j.beat_id))!;
    const art = { ...JSON.parse(String(b.art)), ...(a.art as Record<string, string>) };
    const files = JSON.parse(String(b.files));
    if (art.cover && a.useAsCover !== false) files.cover = art.cover;
    this.sql.exec('UPDATE beats SET art = ?, files = ? WHERE id = ?', JSON.stringify(art), JSON.stringify(files), String(j.beat_id));
    this.sql.exec("UPDATE art_jobs SET status = 'done', updated_at = ? WHERE id = ?", Date.now(), String(j.id));
    return { ok: true };
  }

  private job(a: Args): Row {
    const j = this.one('SELECT * FROM art_jobs WHERE id = ?', text(a.jobId, 40));
    if (!j || j.status === 'done' || j.status === 'failed') throw new ApiError(404, 'Unknown job');
    return j;
  }

  op_jobAudio(_: Viewer, a: Args) {
    const j = this.job(a);
    const files = JSON.parse(String(this.one('SELECT files FROM beats WHERE id = ?', String(j.beat_id))?.files ?? '{}'));
    const key = files.wav ?? files.mp3 ?? files.preview;
    if (!key) throw new ApiError(404, 'No audio');
    this.sql.exec("UPDATE art_jobs SET status = 'rendering', updated_at = ? WHERE id = ?", Date.now(), String(j.id));
    return { key };
  }

  op_jobFileKey(_: Viewer, a: Args) {
    const j = this.job(a);
    const kind = text(a.kind, 20);
    if (!['cover', 'thumbnail', 'youtube', 'short', 'cinematic', 'shortCinematic'].includes(kind)) throw new ApiError(400, 'Unknown art kind');
    return { key: `beats/${j.beat_id}/art-${kind}` };
  }

  /** Test-mode only (no STRIPE_SECRET_KEY): lets local dev mark payouts ready. */
  op_devPayoutsReady(v: Viewer) {
    if (this.env.STRIPE_SECRET_KEY) throw new ApiError(403, 'Not available when Stripe is configured.');
    const me = this.need(v, 'producer');
    this.sql.exec("UPDATE profiles SET stripe_account = 'acct_dev', payouts_ready = 1 WHERE user_id = ?", me.id);
    return { ok: true };
  }

  /** Test-mode only: creates the order the way op_checkout does, without calling Stripe. */
  op_devCheckout(v: Viewer, a: Args) {
    if (this.env.STRIPE_SECRET_KEY) throw new ApiError(403, 'Not available when Stripe is configured.');
    const me = this.need(v);
    const b = this.one("SELECT * FROM beats WHERE id = ? AND status = 'live'", text(a.beatId, 40));
    if (!b) throw new ApiError(404, 'That beat isn’t for sale.');
    const license = text(a.license, 12) as LicenseId;
    const offer = (this.withPrices(this.beatOut(b, me), String(b.producer_id)).offers as { id: string; price: number }[]).find((o) => o.id === license);
    if (!offer) throw new ApiError(400, 'That license isn’t offered for this beat.');
    const orderId = uid('o_');
    const fee = Math.round((offer.price * Number(this.env.PLATFORM_FEE_BPS ?? '1000')) / 10_000);
    this.sql.exec("INSERT INTO orders (id, buyer_id, buyer_email, beat_id, producer_id, license, amount_cents, fee_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      orderId, me.id, me.email, String(b.id), String(b.producer_id), license, offer.price, fee, Date.now());
    return { orderId };
  }
}

function pickBools(src: unknown, keys: string[]): Record<string, boolean> {
  if (!src || typeof src !== 'object') return {};
  return Object.fromEntries(keys.filter((k) => (src as Record<string, unknown>)[k] !== undefined).map((k) => [k, !!(src as Record<string, unknown>)[k]]));
}

function licenseText(o: { beat: string; producer: string; buyer: string; license: LicenseId; date: number; id: string }): string {
  const l = LICENSES[o.license];
  const d = new Date(o.date).toISOString().slice(0, 10);
  return [
    `KARTA BEAT LICENSE · ${l.name.toUpperCase()}`, `License ID: ${o.id}`, `Date: ${d}`, '',
    `Beat: "${o.beat}"`, `Producer (Licensor): ${o.producer}`, `Artist (Licensee): ${o.buyer}`, '',
    o.license === 'exclusive'
      ? 'The Licensor grants the Licensee exclusive rights to the beat. The beat is removed from sale. Unlimited streams, sales and performances. The Licensor keeps writer credit and their share of publishing.'
      : `The Licensor grants the Licensee a non-exclusive license to record one song on the beat and distribute it, up to ${l.streams?.toLocaleString('en-US')} combined streams. The Licensor keeps ownership of the beat and may license it to others.`,
    '', `Files: ${l.files.map((f) => f.toUpperCase()).join(', ')}`,
    `Credit: the song title or description must include "prod. ${o.producer}".`,
    'This license was issued through Karta by STRDM. Payment was processed by Stripe.',
  ].join('\n');
}
