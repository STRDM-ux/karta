# @karta/art-engine

Turns a beat into artwork and posts. Feed it an audio file and it:

1. **Listens.** Tempo, key, energy, brightness, bass weight, hit density, song sections and the drop
   (`src/audio/analyze.ts`, pure TypeScript FFT, no ML model).
2. **Builds a visual DNA** (`src/dna.ts`). The key sets the colour (circle of fifths around the colour
   wheel, minor keys darker and cooler), energy and brightness set saturation and texture, tempo sets
   camera pace and cut length (always whole bars), and genre sets the scene. Same beat, same look.
3. **Draws cover art** (`src/art/cover.ts`) in one of three generative styles, picked from the audio:
   `rings` (bass-heavy, sparse), `flow` (busy, percussive), `skyline` (everything else).
   Outputs a 3000×3000 cover, a clean cover for Higgsfield, a 1280×720 YouTube thumbnail and video frames.
4. **Writes Higgsfield prompts** (`src/higgsfield/prompts.ts`): one cinematic still prompt and one shot
   per song section, timed in bars.
5. **Renders videos** (`src/video/render.ts`, ffmpeg): a 16:9 visualizer of the full beat and a 9:16
   cut that starts at the drop. With `--higgsfield`, it generates clips from the cover with
   Seedance 2.0 reference-to-video and cuts them on the bar line under the beat.
6. **Publishes** (`src/publish/index.ts`) to YouTube (with thumbnail), YouTube Shorts, TikTok and
   Instagram Reels. The TikTok and Instagram flows mirror STRDM's `functions/social-studio.ts`.

## Run it

```bash
npm install            # from the repo root
npm run art -- beat.wav --title "Spanish Town Dusk" --producer "Nine Mile Sound" --genre dancehall
```

Useful flags: `--bpm 96 --key F#m` (the producer's own values beat detection), `--pattern rings`,
`--brand "#ff3d8a"` (STRDM pink as the accent), `--no-video`, `--short 30`.

Cinematic clips and posting:

```bash
HF_API_KEY_ID=… HF_API_KEY_SECRET=… npm run art -- beat.wav --title … --producer … \
  --higgsfield --public-dir /mnt/cdn/karta --public-url https://cdn.example.com/karta

YOUTUBE_ACCESS_TOKEN=… TIKTOK_ACCESS_TOKEN=… npm run art -- beat.wav --title … --producer … \
  --publish youtube,youtube_shorts,tiktok --privacy private
```

Everything lands in `out/<title>/` with a `karta.json` manifest (features, DNA, prompts, copy, results).

## Platform notes

- **Instagram** pulls the video from a public URL, so it needs `--public-dir/--public-url` (in the app
  this will be R2, like STRDM's media).
- **TikTok** only allows private posts until the TikTok app passes audit.
- **YouTube** custom thumbnails need a verified channel; the video still uploads without one.
- Higgsfield outputs expire after about 7 days, so the engine downloads them right away.

## Tests

`npm test` synthesizes beats with a known tempo and key (96 F#m, 140 C#m drill, 104 G, 76 D reggae,
100 Am dancehall) and checks tempo, key, sections and the drop.
