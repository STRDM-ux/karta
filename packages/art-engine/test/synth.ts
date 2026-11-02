import { writeFileSync } from 'node:fs';

/** Builds a test beat with a known tempo and key: soft 8-bar intro, then drums + bass + chords. */
export function synthBeat(opts: { bpm: number; tonic: number; minor: boolean; seconds?: number; sr?: number }): Float32Array {
  const { bpm, tonic, minor } = opts;
  const sr = opts.sr ?? 22050, seconds = opts.seconds ?? 40;
  const out = new Float32Array(Math.floor(sr * seconds));
  const beat = 60 / bpm, bar = beat * 4;
  // i – VI/IV – v/V – i style progression in semitones from the tonic
  const prog = minor ? [[0, 3, 7], [8, 12, 15], [7, 10, 14], [0, 3, 7]] : [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]];
  const hz = (semi: number, oct: number) => 440 * Math.pow(2, (tonic + semi - 9) / 12 + (oct - 4));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const barIdx = Math.floor(t / bar);
    const intro = barIdx < 8;
    const chord = prog[barIdx % 4];
    let s = 0;
    // pads
    for (const semi of chord) s += 0.06 * Math.sin(2 * Math.PI * hz(semi, 4) * t);
    s += 0.05 * Math.sin(2 * Math.PI * hz(0, 3) * t); // tonic drone
    if (!intro) {
      const tb = t % beat;
      // kick on every beat
      s += 0.8 * Math.exp(-tb * 18) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tb * 30)) * tb);
      // snare noise on beats 2 and 4
      const beatIdx = Math.floor(t / beat) % 4;
      if (beatIdx === 1 || beatIdx === 3) s += 0.35 * Math.exp(-tb * 25) * rnd();
      // hats on eighths
      const te = t % (beat / 2);
      s += 0.08 * Math.exp(-te * 120) * rnd();
      // bass on chord root
      s += 0.3 * Math.sin(2 * Math.PI * hz(chord[0], 2) * t) * Math.exp(-(t % bar) * 0.8);
    }
    out[i] = Math.max(-1, Math.min(1, s * 0.8));
  }
  return out;
}

export function writeWav(path: string, x: Float32Array, sr = 22050): void {
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.round(x[i] * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}
