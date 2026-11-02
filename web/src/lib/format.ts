export const money = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 === 0 ? 0 : 2 });

export const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");

export const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function ago(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const KEYS = ["C", "Cm", "C#", "C#m", "D", "Dm", "Eb", "Ebm", "E", "Em", "F", "Fm", "F#", "F#m", "G", "Gm", "Ab", "Abm", "A", "Am", "Bb", "Bbm", "B", "Bm"];
export const GENRES = ["Dancehall", "Reggae", "Afrobeats", "Amapiano", "Drill", "Trap", "Hip Hop", "R&B", "Soca", "Dembow", "Reggaeton", "Pop"];
