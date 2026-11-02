import type { Me } from "./types";

const ENV_URL = ((import.meta.env.VITE_KARTA_API_URL as string | undefined) ?? (import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL as string | undefined))?.trim();
export const API_URL = (ENV_URL && ENV_URL.length > 0 ? ENV_URL : "http://localhost:8787").replace(/\/$/, "");

const TOKEN_KEY = "karta.token";
export const getToken = (): string | null => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
export const setToken = (t: string | null): void => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can’t reach Karta. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  if (!res.ok || data.ok === false) throw new ApiError(res.status, data.error ?? "Something went wrong. Try again.");
  return data.data as T;
}

/** Media paths from the API ("/media/…", "/dl/…") as absolute URLs; private drafts carry the token. */
export function mediaUrl(path: string | undefined | null, opts: { auth?: boolean } = {}): string {
  if (!path) return "";
  if (/^https?:/.test(path)) return path;
  const t = opts.auth ? getToken() : null;
  return `${API_URL}${path}${t ? `${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(t)}` : ""}`;
}

const PART = 4_000_000;
const WHOLE_MAX = 90 * 1024 * 1024;

/** Uploads a file to a PUT endpoint; big files go in 4 MB parts, like STRDM's media uploads. */
export async function upload<T = unknown>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  const token = getToken();
  const send = async (body: Blob, extra: Record<string, string>): Promise<{ ok?: boolean; data?: T; error?: string; status: number }> => {
    const res = await fetch(API_URL + path, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body });
    return { status: res.status, ...((await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string }) };
  };
  if (file.size <= WHOLE_MAX) {
    onProgress?.(0.05);
    const r = await send(file, {});
    if (r.ok === false || r.status >= 400) throw new ApiError(r.status, r.error ?? "Upload failed.");
    onProgress?.(1);
    return r.data as T;
  }
  let last: T | undefined;
  for (let n = 0; n * PART < file.size; n++) {
    const r = await send(file.slice(n * PART, (n + 1) * PART), { "X-Upload-Size": String(file.size), "X-Upload-Part": String(n) });
    if (r.ok === false || r.status >= 400) throw new ApiError(r.status, r.error ?? "Upload failed.");
    last = r.data;
    onProgress?.(Math.min(1, ((n + 1) * PART) / file.size));
  }
  return last as T;
}

export type AuthResult = { token: string; me: Me } | { needsProfile: true; name: string; suggestedHandle: string };
