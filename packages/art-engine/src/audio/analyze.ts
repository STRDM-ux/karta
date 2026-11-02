import { fft, hann } from './fft.js';
import { decodeAudio, SAMPLE_RATE } from './decode.js';

export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
export type PitchClass = (typeof PITCH_CLASSES)[number];

export interface Section {
  label: 'intro' | 'verse' | 'hook' | 'break' | 'outro';
  start: number; // seconds
  end: number;
  energy: number; // 0..1 relative to the track
}

export interface AudioFeatures {
  duration: number;
  bpm: number;
  bpmConfidence: number; // 0..1
  beatOffset: number; // seconds to the first beat
  barSeconds: number; // one 4/4 bar
  key: { tonic: PitchClass; mode: 'major' | 'minor'; label: string; confidence: number };
  chroma: number[]; // 12 values, sums to 1, C first
  loudness: number; // mean RMS in dBFS
  energy: number; // 0..1 overall intensity
  dynamics: number; // 0..1, how much energy moves between quiet and loud parts
  brightness: number; // 0..1 spectral centroid
  bassWeight: number; // 0..1 share of energy below 150 Hz
  density: number; // onsets per second
  energyCurve: number[]; // 64 points, 0..1
  sections: Section[];
  drop: number; // seconds where the track hits hardest; best start for a short clip
}

const WIN = 2048;
const HOP = 512;

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Typical tempo ranges producers list beats in. Used to settle half-time / double-time ambiguity. */
export const GENRE_TEMPO: Record<string, [number, number]> = {
  dancehall: [85, 115], reggae: [60, 100], soca: [140, 170], afrobeats: [95, 125], amapiano: [105, 120],
  drill: [130, 150], trap: [120, 170], 'hip hop': [80, 100], 'boom bap': [80, 98], 'r&b': [60, 100],
  pop: [95, 130], house: [118, 130], dembow: [110, 130], reggaeton: [85, 105],
};

export interface AnalyzeOptions { genre?: string; bpmHint?: number }

export async function analyzeFile(path: string, opts: AnalyzeOptions = {}): Promise<AudioFeatures> {
  return analyzeSamples(await decodeAudio(path), SAMPLE_RATE, opts);
}

export function analyzeSamples(x: Float32Array, sr: number, opts: AnalyzeOptions = {}): AudioFeatures {
  if (x.length < WIN * 4) throw new Error('Audio is too short to analyze (needs at least half a second).');
  const fps = sr / HOP;
  const nFrames = Math.floor((x.length - WIN) / HOP) + 1;
  const nBins = WIN / 2;
  const win = hann(WIN);
  const re = new Float64Array(WIN), im = new Float64Array(WIN);

  const rms = new Float64Array(nFrames);
  const flux = new Float64Array(nFrames);
  // per-frame chroma, summed later from the steady frames only (drum hits smear pitch)
  const frameChroma = new Float32Array(nFrames * 12);
  const frameBass = new Float32Array(nFrames * 12);
  let prevLog = new Float64Array(nBins);
  let centroidSum = 0, centroidW = 0, lowE = 0, totalE = 0;

  // bin -> pitch class, only between C2 (65 Hz) and C7 (2093 Hz)
  const binPc = new Int8Array(nBins).fill(-1);
  for (let k = 1; k < nBins; k++) {
    const f = (k * sr) / WIN;
    if (f >= 65 && f <= 2100) binPc[k] = (((Math.round(12 * Math.log2(f / 440)) + 69) % 12) + 12) % 12;
  }
  const lowBin = Math.round((150 * WIN) / sr);
  const bassTop = Math.round((260 * WIN) / sr);

  for (let t = 0; t < nFrames; t++) {
    const off = t * HOP;
    let e = 0;
    for (let i = 0; i < WIN; i++) {
      const s = x[off + i];
      e += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[t] = Math.sqrt(e / WIN);
    fft(re, im);
    const logMag = new Float64Array(nBins);
    let fl = 0, num = 0, den = 0;
    for (let k = 1; k < nBins; k++) {
      const m = Math.hypot(re[k], im[k]);
      const p = m * m;
      logMag[k] = Math.log1p(100 * m);
      const d = logMag[k] - prevLog[k];
      if (d > 0) fl += d;
      num += k * m; den += m;
      totalE += p;
      if (k <= lowBin) lowE += p;
      if (binPc[k] >= 0) {
        frameChroma[t * 12 + binPc[k]] += m;
        if (k <= bassTop) frameBass[t * 12 + binPc[k]] += m;
      }
    }
    flux[t] = t === 0 ? 0 : fl;
    if (den > 0) { centroidSum += (num / den) * rms[t]; centroidW += rms[t]; }
    prevLog = logMag;
  }

  // Onset envelope: flux minus its local average, half-wave rectified.
  const onset = new Float64Array(nFrames);
  const avgW = Math.round(fps * 0.5);
  let acc = 0;
  for (let t = 0; t < nFrames; t++) {
    acc += flux[t];
    if (t >= avgW) acc -= flux[t - avgW];
    const mean = acc / Math.min(t + 1, avgW);
    onset[t] = Math.max(0, flux[t] - mean);
  }

  const range = opts.genre ? GENRE_TEMPO[opts.genre.toLowerCase()] : undefined;
  const { bpm, confidence: bpmConfidence, period } = estimateTempo(onset, fps, opts.bpmHint ? [opts.bpmHint * 0.94, opts.bpmHint * 1.06] : range);
  const beatOffset = estimatePhase(onset, period) / fps;
  const barSeconds = (60 / bpm) * 4;

  // Key (Krumhansl–Schmuckler) from frames between hits: mostly ignore ~180 ms after a strong onset,
  // where kick sweeps and snares smear the pitch picture.
  const onsetThr = [...onset].sort((a, b) => a - b)[Math.floor(nFrames * 0.7)] ?? 0;
  const chroma = new Float64Array(12), bassChroma = new Float64Array(12);
  for (let t = 0; t < nFrames; t++) {
    let hit = false;
    for (let j = Math.max(0, t - 7); j <= t; j++) if (onset[j] > onsetThr) hit = true;
    const w = hit ? 0.05 : 1;
    for (let c = 0; c < 12; c++) { chroma[c] += w * frameChroma[t * 12 + c]; bassChroma[c] += w * frameBass[t * 12 + c]; }
  }
  const csum = chroma.reduce((a, b) => a + b, 0) || 1;
  const chromaN = Array.from(chroma, (c) => c / csum);
  const bsum = bassChroma.reduce((a, b) => a + b, 0) || 1;
  const key = estimateKey(chromaN, Array.from(bassChroma, (c) => c / bsum));

  // Loudness, energy, dynamics.
  const dbs = Array.from(rms, (r) => 20 * Math.log10(r + 1e-9));
  const loud = dbs.filter((d) => d > -60);
  const loudness = loud.length ? loud.reduce((a, b) => a + b, 0) / loud.length : -60;
  const sortedDb = [...loud].sort((a, b) => a - b);
  const pct = (p: number) => sortedDb[Math.min(sortedDb.length - 1, Math.floor(p * sortedDb.length))] ?? -60;
  const dynamics = clamp01((pct(0.95) - pct(0.2)) / 24);
  const density = countPeaks(onset, fps) / (x.length / sr);
  const energy = clamp01(0.55 * clamp01((loudness + 30) / 22) + 0.45 * clamp01(density / 6));
  const brightness = clamp01((centroidW ? centroidSum / centroidW : 0) / nBins / 0.25);
  const bassWeight = clamp01(totalE ? (lowE / totalE) : 0);

  // Energy per bar, then a smooth 64-point curve for the art.
  const barFrames = Math.max(1, Math.round(barSeconds * fps));
  const startFrame = Math.round(beatOffset * fps);
  const bars: number[] = [];
  for (let b = startFrame; b < nFrames; b += barFrames) {
    let s = 0, n = 0;
    for (let t = b; t < Math.min(nFrames, b + barFrames); t++) { s += rms[t]; n++; }
    bars.push(n ? s / n : 0);
  }
  const barMax = Math.max(...bars, 1e-9);
  const barEnergy = bars.map((b) => b / barMax);
  const energyCurve = resample(Array.from(rms), 64);
  const curveMax = Math.max(...energyCurve, 1e-9);

  const duration = x.length / sr;
  const sections = findSections(barEnergy, beatOffset, barSeconds, duration);
  const drop = findDrop(barEnergy, beatOffset, barSeconds);
  // a section change within a bar of the drop is the drop
  for (let i = 1; i < sections.length; i++) {
    if (Math.abs(sections[i].start - drop) <= barSeconds * 1.01) { sections[i].start = drop; sections[i - 1].end = drop; }
  }

  return {
    duration, bpm, bpmConfidence, beatOffset, barSeconds, key, chroma: chromaN.map(round3),
    loudness: round3(loudness), energy: round3(energy), dynamics: round3(dynamics),
    brightness: round3(brightness), bassWeight: round3(bassWeight), density: round3(density),
    energyCurve: energyCurve.map((v) => round3(v / curveMax)), sections, drop,
  };
}

/** Autocorrelation of the onset envelope, weighted toward common hip-hop / dancehall tempos. */
function estimateTempo(onset: Float64Array, fps: number, range?: [number, number]) {
  const n = onset.length;
  const mean = onset.reduce((a, b) => a + b, 0) / n;
  const o = Array.from(onset, (v) => v - mean);
  const maxLag = Math.min(n - 1, Math.ceil((60 * fps) / 50) * 2);
  const ac = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag; l++) {
    let s = 0;
    for (let t = l; t < n; t++) s += o[t] * o[t - l];
    ac[l] = s / (n - l);
  }
  const ac0 = ac[0] || 1;
  let best = { score: -Infinity, lag: 0 };
  const minLag = Math.floor((60 * fps) / 200), maxBpmLag = Math.ceil((60 * fps) / 60);
  for (let l = minLag; l <= maxBpmLag && l * 2 <= maxLag; l++) {
    const bpm = (60 * fps) / l;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.75, 2));
    // a true beat period also lines up at 2x and 4x the lag (bar structure)
    const support = ac[l] + 0.5 * ac[2 * l] + (4 * l <= maxLag ? 0.25 * ac[4 * l] : 0);
    const score = (support / ac0) * prior;
    if (score > best.score) best = { score, lag: l };
  }
  // Half-time / double-time: if the genre (or the producer's BPM) says otherwise, move by an octave
  // and re-pick the strongest lag near the new period.
  if (range) {
    let bpm0 = (60 * fps) / best.lag;
    let guard = 0;
    while (bpm0 < range[0] && guard++ < 3) bpm0 *= 2;
    while (bpm0 > range[1] && guard++ < 6) bpm0 /= 2;
    const target = (60 * fps) / bpm0;
    let pick = Math.round(target);
    for (let l = Math.floor(target * 0.97); l <= Math.ceil(target * 1.03); l++) if (l <= maxLag && ac[l] > ac[pick]) pick = l;
    best = { score: best.score, lag: pick };
  }
  // parabolic refinement around the peak
  const l = best.lag;
  const y0 = ac[l - 1] ?? ac[l], y1 = ac[l], y2 = ac[l + 1] ?? ac[l];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const period = l + shift;
  const bpm = Math.round(((60 * fps) / period) * 10) / 10;
  return { bpm, period, confidence: round3(clamp01(ac[l] / ac0 * 2)) };
}

function estimatePhase(onset: Float64Array, period: number): number {
  let best = 0, bestSum = -Infinity;
  for (let ph = 0; ph < period; ph++) {
    let s = 0;
    for (let t = ph; t < onset.length; t += period) s += onset[Math.round(t)] ?? 0;
    if (s > bestSum) { bestSum = s; best = ph; }
  }
  return best;
}

function estimateKey(chroma: number[], bass: number[]) {
  let best = { r: -Infinity, tonic: 0, mode: 'major' as 'major' | 'minor' };
  let second = -Infinity;
  for (const [mode, prof] of [['major', MAJOR], ['minor', MINOR]] as const) {
    for (let t = 0; t < 12; t++) {
      const rotated = prof.map((_, i) => prof[(i - t + 12) % 12]);
      // the bass usually sits on the tonic: this separates a minor key from its relative major
      const r = pearson(chroma, rotated) + 1.0 * bass[t];
      if (r > best.r) { second = best.r; best = { r, tonic: t, mode }; } else if (r > second) second = r;
    }
  }
  const tonic = PITCH_CLASSES[best.tonic];
  return { tonic, mode: best.mode, label: tonic + (best.mode === 'minor' ? 'm' : ''), confidence: round3(clamp01((best.r - second) * 5 + best.r * 0.5)) };
}

function findSections(bars: number[], offset: number, barS: number, duration: number): Section[] {
  if (!bars.length) return [{ label: 'verse', start: 0, end: duration, energy: 1 }];
  // smooth over 2 bars, quantize into 3 levels, then merge runs shorter than 4 bars
  const sm = bars.map((_, i) => (bars[Math.max(0, i - 1)] + bars[i] + bars[Math.min(bars.length - 1, i + 1)]) / 3);
  // quantize the raw bar energy so boundaries land on the bar where the change happens
  const level = bars.map((v) => (v > 0.78 ? 2 : v > 0.5 ? 1 : 0));
  const runs: { level: number; from: number; to: number }[] = [];
  level.forEach((lv, i) => {
    const last = runs[runs.length - 1];
    if (last && last.level === lv) last.to = i; else runs.push({ level: lv, from: i, to: i });
  });
  for (let changed = true; changed && runs.length > 1;) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].to - runs[i].from + 1 < 4) {
        const j = i === 0 ? 1 : i === runs.length - 1 ? i - 1 : (runs[i - 1].to - runs[i - 1].from >= runs[i + 1].to - runs[i + 1].from ? i - 1 : i + 1);
        runs[j].from = Math.min(runs[j].from, runs[i].from);
        runs[j].to = Math.max(runs[j].to, runs[i].to);
        runs.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return runs.map((r, i) => {
    const e = sm.slice(r.from, r.to + 1).reduce((a, b) => a + b, 0) / (r.to - r.from + 1);
    const label: Section['label'] = r.level === 2 ? 'hook' : r.level === 1 ? 'verse' : i === 0 ? 'intro' : i === runs.length - 1 ? 'outro' : 'break';
    const start = i === 0 ? 0 : offset + r.from * barS;
    const end = i === runs.length - 1 ? duration : offset + (r.to + 1) * barS;
    return { label, start: round3(start), end: round3(Math.min(end, duration)), energy: round3(e) };
  });
}

function findDrop(bars: number[], offset: number, barS: number): number {
  let best = 0, bestRise = -Infinity;
  for (let i = 1; i < bars.length; i++) {
    const before = bars.slice(Math.max(0, i - 4), i);
    const prev = before.reduce((a, b) => a + b, 0) / before.length;
    const after = bars.slice(i, i + 4);
    const next = after.reduce((a, b) => a + b, 0) / after.length;
    const rise = next - prev + next * 0.3;
    if (rise > bestRise) { bestRise = rise; best = i; }
  }
  return round3(offset + best * barS);
}

function countPeaks(env: Float64Array, fps: number): number {
  const sorted = Array.from(env).sort((a, b) => a - b);
  const thr = sorted[Math.floor(sorted.length * 0.85)] || 0;
  const gap = Math.round(fps * 0.06);
  let count = 0, last = -gap;
  for (let t = 1; t < env.length - 1; t++) {
    if (env[t] > thr && env[t] >= env[t - 1] && env[t] >= env[t + 1] && t - last >= gap) { count++; last = t; }
  }
  return count;
}

function resample(arr: number[], n: number): number[] {
  const out: number[] = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
    let s = 0;
    for (let j = a; j < b; j++) s += arr[j];
    out.push(s / (b - a));
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
