import type { AudioFeatures } from './audio/analyze.js';
import { PITCH_CLASSES } from './audio/analyze.js';

/**
 * Visual DNA: the bridge between sound and image. Every visual decision downstream
 * (palette, pattern, camera, cut length, Higgsfield prompt) is read from here, so the
 * same beat always produces the same look, and different beats look different.
 */
export interface VisualDNA {
  seed: number;
  hue: number;
  palette: { bg: string; deep: string; primary: string; secondary: string; accent: string; light: string };
  mood: string[];
  texture: string[];
  motion: { pace: 'drift' | 'pulse' | 'surge' | 'strobe'; camera: string; cutSeconds: number };
  scene: string;
  pattern: 'rings' | 'flow' | 'skyline';
  intensity: number; // 0..1
  meta: { title: string; producer: string; genre: string; bpm: number; key: string };
}

export interface BeatMeta {
  title: string;
  producer: string;
  genre?: string;
  tags?: string[];
  pattern?: VisualDNA['pattern'];
  /** Brand color (hex) that replaces the accent, e.g. STRDM gold. */
  brandAccent?: string;
}

const SCENES: Record<string, string> = {
  dancehall: 'a Kingston street dance at night, towering sound-system speaker boxes, string lights, heat haze',
  reggae: 'Blue Mountain ridges at golden hour, mist rolling through the valley, a lone vintage speaker on a hill',
  soca: 'carnival road march at sunrise, feathers and glitter in the air, steel pan sheen',
  afrobeats: 'a Lagos rooftop at dusk, warm city lights below, wind moving through fabric',
  amapiano: 'a packed township dance floor, log-drum shockwaves rippling through the crowd, warm tungsten light',
  drill: 'brutalist concrete estate under an overcast sky, sodium streetlights, wet tarmac',
  trap: 'a neon-lit underpass after rain, chrome reflections, smoke drifting through headlights',
  'hip hop': 'a late-night corner store and brownstones, steam from a grate, film-camera grain',
  'r&b': 'a high-rise apartment at 3am, city bokeh through rain-streaked glass, silk and candlelight',
  dembow: 'a crowded colmado block party, motorbikes, saturated signage, humid night',
  reggaeton: 'a tropical nightclub courtyard, palm silhouettes, laser haze',
};

export function buildDNA(f: AudioFeatures, meta: BeatMeta): VisualDNA {
  const tonicIdx = PITCH_CLASSES.indexOf(f.key.tonic);
  // Circle of fifths around the colour wheel: related keys get related colours.
  const fifthsPos = (tonicIdx * 7) % 12;
  const minor = f.key.mode === 'minor';
  const hue = mod(fifthsPos * 30 + (minor ? -24 : 8), 360);
  const e = f.energy, b = f.brightness;

  const palette = {
    bg: hsl(hue, 30 + 20 * e, minor ? 6 : 10),
    deep: hsl(hue + (minor ? -12 : 10), 45 + 20 * e, minor ? 15 : 22),
    primary: hsl(hue, 62 + 30 * e, 48 + 12 * b),
    secondary: hsl(hue + (e > 0.6 ? 150 : 38), 55 + 25 * e, 52 + 8 * b),
    accent: meta.brandAccent ?? hsl(hue + 180, 80, 60 + 6 * b),
    light: hsl(hue, 35, 93),
  };

  const mood = minor
    ? e > 0.55 ? ['menacing', 'urgent', 'nocturnal'] : ['melancholic', 'hazy', 'intimate']
    : e > 0.55 ? ['triumphant', 'sun-drenched', 'euphoric'] : ['warm', 'nostalgic', 'easygoing'];
  if (f.dynamics > 0.55) mood.push('dramatic contrast');

  const texture = [
    b > 0.45 ? 'crisp glassy highlights, sharp edges' : 'velvet shadows, soft film grain',
    f.bassWeight > 0.3 ? 'low-lying fog that ripples with the sub-bass' : 'clear air, long depth of field',
    f.density > 4 ? 'drifting particles and sparks on every hit' : 'smooth gradients and long light trails',
  ];

  const pace: VisualDNA['motion']['pace'] = f.bpm < 85 ? 'drift' : f.bpm < 112 ? 'pulse' : f.bpm < 140 || f.density < 5 ? 'surge' : 'strobe';
  const camera = {
    drift: 'slow dolly-in, floating camera, long unbroken takes',
    pulse: 'steady push-in with a slight sway on the backbeat',
    surge: 'fast tracking shots, whip pans landing on the downbeat',
    strobe: 'rapid cuts, snap zooms, flash frames on the snare',
  }[pace];
  // Cuts land on bar lines: 2 bars when slow, 1 bar otherwise.
  const cutSeconds = round2(f.barSeconds * (pace === 'drift' ? 2 : 1));

  const pattern = meta.pattern ?? (f.density > 4.5 ? 'flow' : f.bassWeight > 0.32 ? 'rings' : 'skyline');
  const genre = (meta.genre ?? '').toLowerCase();

  return {
    seed: hash(`${meta.title}|${f.bpm}|${f.key.label}|${f.energyCurve.slice(0, 8).join(',')}`),
    hue, palette, mood, texture,
    motion: { pace, camera, cutSeconds },
    scene: SCENES[genre] ?? 'an empty city at blue hour, light reflecting off wet streets',
    pattern, intensity: e,
    meta: { title: meta.title, producer: meta.producer, genre: meta.genre ?? '', bpm: Math.round(f.bpm), key: f.key.label },
  };
}

export function hsl(h: number, s: number, l: number): string {
  h = mod(h, 360); s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32) so a beat always renders the same art. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (v: number, m: number) => ((v % m) + m) % m;
const round2 = (v: number) => Math.round(v * 100) / 100;
