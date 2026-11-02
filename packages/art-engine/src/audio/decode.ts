import { spawn } from 'node:child_process';

export const SAMPLE_RATE = 22050;

/** Decode any audio file ffmpeg understands into mono float samples at 22.05 kHz. */
export function decodeAudio(path: string, sampleRate = SAMPLE_RATE): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (c: Buffer) => (err += c.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${path}: ${err.trim()}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(buf.length / 4);
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}
