import { ApiError, timingSafeEqual } from './util';

/** Minimal Stripe REST client (form-encoded), the same approach as STRDM's payments.ts. */
export async function stripe<T = Record<string, unknown>>(secret: string | undefined, method: 'GET' | 'POST', path: string, form?: Record<string, string | number | boolean | undefined>): Promise<T> {
  if (!secret) throw new ApiError(503, 'Payments are not set up yet. Add STRIPE_SECRET_KEY.');
  const body = form ? new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string])) : undefined;
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'GET' ? undefined : body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new ApiError(res.status >= 500 ? 502 : 400, `Stripe: ${data.error?.message ?? res.status}`);
  return data;
}

/** Verifies a `Stripe-Signature` header (v1 HMAC-SHA256, 5 minute tolerance). Ported from STRDM. */
export async function verifyStripeSignature(payload: string, header: string, secret: string, now = Date.now()): Promise<boolean> {
  const parts = header.split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}
