// Remembers which Karta ad (and which platform click id) brought a buyer here, for 30 days, so a sale
// can be credited to the right ad. Karta's ad links carry ?kc=<arm>; Meta, TikTok and Google add their own
// click ids (fbclid, ttclid, gclid) automatically.
const KEY = "karta.attr";
const DAYS = 30;

export interface Attribution { arm: string; clickId?: string; at: number }

export function captureAttribution(): void {
  try {
    const p = new URLSearchParams(location.search);
    const arm = p.get("kc");
    if (!arm || !/^arm_[a-z0-9]+$/i.test(arm)) return;
    const clickId = p.get("ttclid") ?? p.get("fbclid") ?? p.get("gclid") ?? undefined;
    localStorage.setItem(KEY, JSON.stringify({ arm, clickId, at: Date.now() } satisfies Attribution));
  } catch { /* storage blocked */ }
}

export function attribution(): Attribution | undefined {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "null") as Attribution | null;
    if (!a || Date.now() - a.at > DAYS * 86_400_000) return undefined;
    return a;
  } catch { return undefined; }
}
