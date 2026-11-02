export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

export const uid = (prefix = ''): string => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

export function multiline(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

export function cents(v: unknown, { min = 0, max = 10_000_000 } = {}): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const RESERVED = new Set(['admin', 'karta', 'strdm', 'store', 'studio', 'settings', 'login', 'signup', 'library', 'feed', 'charts', 'beat', 'u', 'api', 'support', 'help']);

export function cleanHandle(v: unknown): string {
  const h = text(v, 30).toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_.]{3,30}$/.test(h)) throw new ApiError(400, 'Handles are 3–30 letters, numbers, dots or underscores.');
  if (RESERVED.has(h)) throw new ApiError(400, 'That handle is reserved. Pick another one.');
  return h;
}
