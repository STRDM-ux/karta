import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples } from '../src/audio/analyze.js';
import { synthBeat } from './synth.js';

const cases: { bpm: number; tonic: number; minor: boolean; label: string; genre?: string }[] = [
  { bpm: 96, tonic: 6, minor: true, label: 'F#m' },                     // no genre given
  { bpm: 140, tonic: 1, minor: true, label: 'C#m', genre: 'drill' },
  { bpm: 104, tonic: 7, minor: false, label: 'G' },
  { bpm: 76, tonic: 2, minor: false, label: 'D', genre: 'reggae' },
  { bpm: 100, tonic: 9, minor: true, label: 'Am', genre: 'dancehall' },
];

for (const c of cases) {
  test(`detects ${c.bpm} BPM in ${c.label}`, () => {
    const f = analyzeSamples(synthBeat(c), 22050, { genre: c.genre });
    assert.ok(Math.abs(f.bpm - c.bpm) <= 1.5, `bpm ${f.bpm} != ${c.bpm}`);
    assert.equal(f.key.label, c.label);
    assert.ok(f.drop >= 8 * (240 / c.bpm) - 0.75 * (240 / c.bpm), `drop at ${f.drop}s should be at or after the 8-bar intro`);
    assert.equal(f.energyCurve.length, 64);
    assert.ok(f.sections.length >= 2, 'intro and main section should split');
  });
}
