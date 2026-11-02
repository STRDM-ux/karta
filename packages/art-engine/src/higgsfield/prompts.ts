import type { AudioFeatures, Section } from '../audio/analyze.js';
import type { VisualDNA } from '../dna.js';

export interface Shot {
  section: Section['label'];
  start: number;
  duration: number; // seconds, a whole number of bars, 4–15
  prompt: string;
}

const SHOT_BY_SECTION: Record<Section['label'], string> = {
  intro: 'establishing shot, the world before the beat drops, stillness and atmosphere',
  verse: 'medium tracking shot moving through the scene, rhythm in the environment',
  hook: 'hero shot at full intensity, light bursts and movement hitting on every kick',
  break: 'macro detail shot, textures up close, breathing room',
  outro: 'slow pull-back, the scene fading into the dark',
};

export function hueName(h: number): string {
  const names: [number, string][] = [[15, 'crimson'], [40, 'ember orange'], [60, 'amber gold'], [85, 'acid yellow'], [150, 'emerald'],
    [185, 'teal'], [210, 'electric cyan'], [245, 'cobalt blue'], [275, 'indigo'], [310, 'violet'], [340, 'magenta'], [360, 'crimson']];
  return names.find(([max]) => h % 360 <= max)![1];
}

function colourWords(dna: VisualDNA): string {
  return `${hueName(dna.hue)} and ${hueName(dna.hue + (dna.intensity > 0.6 ? 150 : 38))} light against near-black, ${hueName(dna.hue + 180)} highlights`;
}

/** Prompt for a cinematic still (alternate cover / YouTube thumbnail background). */
export function stillPrompt(dna: VisualDNA): string {
  return [
    `Cinematic album artwork for a ${dna.meta.genre || 'instrumental'} beat`,
    `${dna.mood.join(', ')} mood`,
    dna.scene,
    colourWords(dna),
    dna.texture.join('; '),
    'anamorphic lens, shallow depth of field, 35mm film grain, square composition with a clear focal point',
    'no text, no letters, no logos, no watermark',
  ].join('. ') + '.';
}

/** One shot per section (max 6), timed to whole bars so cuts land on the downbeat. */
export function shotList(f: AudioFeatures, dna: VisualDNA, max = 6): Shot[] {
  const bars = (sec: number) => Math.max(1, Math.round(sec / f.barSeconds));
  const shots = f.sections.slice(0, max).map((s) => {
    let dur = bars(Math.min(s.end - s.start, 15)) * f.barSeconds;
    while (dur > 15) dur -= f.barSeconds;
    if (dur < 4) dur = Math.ceil(4 / f.barSeconds) * f.barSeconds;
    return {
      section: s.label,
      start: s.start,
      duration: Math.round(Math.min(15, dur) * 100) / 100,
      prompt: [
        SHOT_BY_SECTION[s.label],
        `animate the reference artwork into ${dna.scene}`,
        `${dna.mood.join(', ')}`,
        `camera: ${dna.motion.camera}, motion locked to ${dna.meta.bpm} BPM`,
        colourWords(dna),
        dna.texture.join('; '),
        `intensity ${Math.round(s.energy * 10)}/10`,
        'cinematic, no text, no logos',
      ].join('. ') + '.',
    };
  });
  // make sure the drop gets a hook shot even if sections merged it away
  if (!shots.some((s) => s.section === 'hook')) {
    shots.push({ section: 'hook', start: f.drop, duration: Math.min(15, Math.max(4, f.barSeconds * 2)), prompt: SHOT_BY_SECTION.hook + `. ${dna.scene}. camera: ${dna.motion.camera}. ${colourWords(dna)}. cinematic, no text.` });
  }
  return shots;
}
