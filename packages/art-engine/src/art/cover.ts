import sharp from 'sharp';
import type { AudioFeatures } from '../audio/analyze.js';
import { rng, type VisualDNA } from '../dna.js';

/**
 * Generative cover art drawn from the song itself:
 *  - rings:   concentric rings whose radius follows the energy curve (bass-heavy, sparse beats)
 *  - flow:    a flow field whose angles come from the song's chroma (busy, percussive beats)
 *  - skyline: the energy curve as a mirrored skyline over a horizon (everything else)
 * Same beat in, same picture out.
 */
export function coverSVG(f: AudioFeatures, dna: VisualDNA, opts: { size?: number; text?: boolean } = {}): string {
  const S = opts.size ?? 3000;
  const p = dna.palette;
  const r = rng(dna.seed);
  const body = dna.pattern === 'rings' ? rings(f, dna, S, r) : dna.pattern === 'flow' ? flow(f, dna, S, r) : skyline(f, dna, S, r);
  const text = opts.text === false ? '' : titleBlock(dna, S);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg}"/><stop offset="1" stop-color="${p.deep}"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${p.primary}" stop-opacity="0.55"/><stop offset="1" stop-color="${p.primary}" stop-opacity="0"/></radialGradient>
  <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></radialGradient>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${(0.9 * 1000 / S).toFixed(3)}" numOctaves="2" seed="${dna.seed % 1000}"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0"/></filter>
  <filter id="soft"><feGaussianBlur stdDeviation="${S / 120}"/></filter>
</defs>
<rect width="${S}" height="${S}" fill="url(#bg)"/>
${body}
<rect width="${S}" height="${S}" fill="url(#vig)"/>
<rect width="${S}" height="${S}" filter="url(#grain)"/>
${text}
</svg>`;
}

function rings(f: AudioFeatures, dna: VisualDNA, S: number, r: () => number): string {
  const p = dna.palette, cx = S / 2, cy = S * 0.46, curve = smooth(f.energyCurve, 2);
  const count = 26 + Math.round(dna.intensity * 20);
  const colors = [p.primary, p.secondary, p.accent];
  let out = `<circle cx="${cx}" cy="${cy}" r="${S * 0.36}" fill="url(#glow)" filter="url(#soft)"/>`;
  for (let i = 0; i < count; i++) {
    const base = S * (0.06 + 0.36 * (i / count));
    const amp = S * 0.035 * (0.4 + dna.intensity) * (1 - i / count / 2);
    const rot = r() * Math.PI * 2;
    const pts: string[] = [];
    const n = 180;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const u = k / n, tri = u < 0.5 ? u * 2 : 2 - u * 2; // out and back, so the ring closes cleanly
      const e = curve[Math.round(tri * (curve.length - 1))];
      const chromaWob = f.chroma[i % 12] * 2.2;
      const rad = base + amp * (e - 0.5) * 2 + amp * 0.4 * Math.sin(a * (3 + (i % 5)) + rot) * chromaWob;
      pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
    }
    const c = colors[i % 3];
    out += `<polygon points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-opacity="${(0.25 + 0.6 * (1 - i / count)).toFixed(2)}" stroke-width="${(S / 900 * (1 + (i % 4))).toFixed(1)}"/>`;
  }
  return out + `<circle cx="${cx}" cy="${cy}" r="${S * 0.045}" fill="${p.light}" fill-opacity="0.9"/>`;
}

function flow(f: AudioFeatures, dna: VisualDNA, S: number, r: () => number): string {
  const p = dna.palette;
  // angle field built from the 12 chroma strengths: each pitch class adds a sine layer
  const layers = f.chroma.map((c, i) => ({ w: c * 6, fx: (1 + (i % 4)) * 1.3, fy: (1 + ((i * 5) % 4)) * 1.1, ph: r() * 6.28 }));
  const angle = (x: number, y: number) => {
    let a = 0;
    for (const l of layers) a += l.w * Math.sin(x * l.fx * 2 * Math.PI + l.ph) * Math.cos(y * l.fy * 2 * Math.PI - l.ph);
    return a * Math.PI;
  };
  const colors = [p.primary, p.secondary, p.accent, p.light];
  const lines = Math.round(500 + 900 * Math.min(1, f.density / 8));
  const steps = 70, step = S / 260;
  let out = `<circle cx="${S / 2}" cy="${S * 0.45}" r="${S * 0.42}" fill="url(#glow)" filter="url(#soft)"/>`;
  for (let i = 0; i < lines; i++) {
    let x = r(), y = r();
    let d = `M${(x * S).toFixed(1)} ${(y * S).toFixed(1)}`;
    for (let k = 0; k < steps; k++) {
      const a = angle(x, y);
      x += (Math.cos(a) * step) / S; y += (Math.sin(a) * step) / S;
      if (x < 0 || x > 1 || y < 0 || y > 1) break;
      d += `L${(x * S).toFixed(1)} ${(y * S).toFixed(1)}`;
    }
    const pick = r();
    const c = colors[pick < 0.38 ? 0 : pick < 0.68 ? 1 : pick < 0.9 ? 2 : 3];
    out += `<path d="${d}" fill="none" stroke="${c}" stroke-opacity="${(0.25 + r() * 0.55).toFixed(2)}" stroke-width="${(S / 1500 * (1 + r() * 2.5)).toFixed(1)}" stroke-linecap="round"/>`;
  }
  return out;
}

function skyline(f: AudioFeatures, dna: VisualDNA, S: number, r: () => number): string {
  const p = dna.palette, horizon = S * 0.62, curve = smooth(f.energyCurve, 1);
  let out = `<circle cx="${S / 2}" cy="${horizon - S * 0.08}" r="${S * 0.2}" fill="${p.accent}"/>`;
  // sun stripes count = bars per phrase feel, from tempo
  const stripes = 5 + Math.round(f.bpm / 40);
  for (let i = 0; i < stripes; i++) {
    const y = horizon - S * 0.08 + (i / stripes) * S * 0.2;
    out += `<rect x="${S * 0.25}" y="${y.toFixed(1)}" width="${S * 0.5}" height="${(S * 0.004 * (1 + i)).toFixed(1)}" fill="${p.bg}"/>`;
  }
  out += `<ellipse cx="${S / 2}" cy="${horizon}" rx="${S * 0.6}" ry="${S * 0.12}" fill="url(#glow)" filter="url(#soft)"/>`;
  const n = curve.length, w = S / n;
  for (let i = 0; i < n; i++) {
    const h = S * (0.05 + 0.32 * curve[i]) * (0.85 + r() * 0.3);
    const x = i * w;
    const c = i % 7 === 0 ? p.secondary : p.primary;
    out += `<rect x="${(x + w * 0.12).toFixed(1)}" y="${(horizon - h).toFixed(1)}" width="${(w * 0.76).toFixed(1)}" height="${h.toFixed(1)}" fill="${c}" fill-opacity="0.92"/>`;
    out += `<rect x="${(x + w * 0.12).toFixed(1)}" y="${horizon.toFixed(1)}" width="${(w * 0.76).toFixed(1)}" height="${(h * 0.55).toFixed(1)}" fill="${c}" fill-opacity="0.18"/>`;
  }
  // perspective floor grid; line spacing follows the beat
  const lines = 10 + Math.round(f.bpm / 12);
  for (let i = 1; i <= lines; i++) {
    const t = i / lines, y = horizon + (S - horizon) * t * t;
    out += `<line x1="0" x2="${S}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${p.secondary}" stroke-opacity="${(0.15 + 0.4 * t).toFixed(2)}" stroke-width="${S / 1000}"/>`;
  }
  for (let i = -12; i <= 12; i++) {
    out += `<line x1="${S / 2 + i * S * 0.02}" y1="${horizon}" x2="${S / 2 + i * S * 0.22}" y2="${S}" stroke="${p.secondary}" stroke-opacity="0.3" stroke-width="${S / 1000}"/>`;
  }
  return out;
}

function titleBlock(dna: VisualDNA, S: number): string {
  const p = dna.palette, m = dna.meta;
  const size = Math.round(Math.min(S * 0.075, (S * 0.84) / (m.title.length * 0.68)));
  return `<g font-family="Sora, Manrope, 'DejaVu Sans', sans-serif">
  <text x="${S * 0.07}" y="${S * 0.86}" font-size="${size}" font-weight="700" fill="${p.light}" letter-spacing="${S * 0.002}">${esc(m.title.toUpperCase())}</text>
  <text x="${S * 0.07}" y="${S * 0.92}" font-size="${Math.round(S * 0.026)}" fill="${p.light}" fill-opacity="0.75" letter-spacing="${S * 0.004}">${esc(m.producer.toUpperCase())}</text>
  <text x="${S * 0.93}" y="${S * 0.92}" text-anchor="end" font-family="'DejaVu Sans Mono', monospace" font-size="${Math.round(S * 0.022)}" fill="${p.accent}">${m.bpm} BPM · ${esc(m.key)}</text>
</g>`;
}

export interface RenderedArt {
  cover: string;        // 3000x3000 JPG with title, for stores and DSPs
  coverClean: string;   // 3000x3000 JPG without text, reference image for Higgsfield
  thumbnail: string;    // 1280x720 JPG for YouTube
  frameWide: string;    // 1920x1080 PNG background for the 16:9 visualizer
  frameTall: string;    // 1080x1920 PNG background for 9:16 Shorts / Reels / TikTok
}

export async function renderArt(f: AudioFeatures, dna: VisualDNA, outDir: string): Promise<RenderedArt> {
  const out = (n: string) => `${outDir}/${n}`;
  const clean = await sharp(Buffer.from(coverSVG(f, dna, { text: false }))).png().toBuffer();
  await sharp(Buffer.from(coverSVG(f, dna))).jpeg({ quality: 92, mozjpeg: true }).toFile(out('cover.jpg'));
  await sharp(clean).jpeg({ quality: 92, mozjpeg: true }).toFile(out('cover-clean.jpg'));

  // wide: blurred, darkened cover fills the frame; the sharp cover sits left; title on the right
  const wide = async (W: number, H: number, file: string, fmt: 'png' | 'jpeg') => {
    const bg = await sharp(clean).resize(W, W).extract({ left: 0, top: Math.round((W - H) / 2), width: W, height: H }).blur(40).modulate({ brightness: 0.45 }).toBuffer();
    const art = Math.round(H * 0.64);
    const card = await sharp(clean).resize(art, art).toBuffer();
    const m = dna.meta, p = dna.palette;
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g font-family="Sora, 'DejaVu Sans', sans-serif">
      <text x="${W * 0.47}" y="${H * 0.36}" font-size="${Math.round(Math.min(H * 0.1, (W * 0.48) / (fit(m.title, 24).length * 0.6)))}" font-weight="700" fill="${p.light}">${esc(fit(m.title, 24))}</text>
      <text x="${W * 0.47}" y="${H * 0.46}" font-size="${Math.round(H * 0.045)}" fill="${p.light}" fill-opacity="0.8">${esc(m.producer)}${m.genre ? ' · ' + esc(m.genre) : ''}</text>
      <text x="${W * 0.47}" y="${H * 0.55}" font-family="'DejaVu Sans Mono', monospace" font-size="${Math.round(H * 0.04)}" fill="${p.accent}">${m.bpm} BPM · ${esc(m.key)}</text></g></svg>`);
    const img = sharp(bg).composite([{ input: card, left: Math.round(W * 0.06), top: Math.round(H * 0.08) }, { input: label, left: 0, top: 0 }]);
    await (fmt === 'png' ? img.png() : img.jpeg({ quality: 88, mozjpeg: true })).toFile(file);
  };
  await wide(1280, 720, out('thumbnail.jpg'), 'jpeg');
  await wide(1920, 1080, out('frame-wide.png'), 'png');

  // tall: cover centred on a blurred field, room at the bottom for the waveform
  const W = 1080, H = 1920;
  const bgT = await sharp(clean).resize(H, H).extract({ left: Math.round((H - W) / 2), top: 0, width: W, height: H }).blur(40).modulate({ brightness: 0.45 }).toBuffer();
  const sq = await sharp(Buffer.from(coverSVG(f, dna))).resize(960, 960).toBuffer();
  await sharp(bgT).composite([{ input: sq, left: 60, top: 300 }]).png().toFile(out('frame-tall.png'));

  return { cover: out('cover.jpg'), coverClean: out('cover-clean.jpg'), thumbnail: out('thumbnail.jpg'), frameWide: out('frame-wide.png'), frameTall: out('frame-tall.png') };
}

function smooth(a: number[], k: number): number[] {
  return a.map((_, i) => { let s = 0, n = 0; for (let j = i - k; j <= i + k; j++) if (a[j] != null) { s += a[j]; n++; } return s / n; });
}
const fit = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
