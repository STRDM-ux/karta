# Karta Live for FL Studio

See what Higgsfield is making for your beat while you're still in FL Studio, in time with the playlist.

```
FL Studio ── device_KartaLive.py ──(karta_state.json / karta_cmd.json)── Karta Live (localhost:4747)
                                                                           │  art engine: tempo, key, sections, drop, cover
                                                                           │  Higgsfield: one clip per section, 16:9 + 9:16
                                                                           └─ Karta: hosts the cover so Higgsfield can read it
```

- **FL script** (`fl-studio/Karta Live/device_KartaLive.py`). It shares tempo, playhead, play/stop, project title and song
  length about 20 times a second. It also takes commands back: seek, play, stop, toggle and a hint-bar message.
  FL scripts can't open network connections, so the two sides swap two small JSON files in the script's
  folder, with atomic writes.
- **Karta Live** (`karta-live/`) is a local app.
  - It renders the beat with `@karta/art-engine`, sends each song section to Higgsfield (Seedance 2.0
    reference-to-video, the cover as reference) and streams every step to the preview window over SSE.
  - The window plays the clip for whichever section FL's playhead is in, and keeps it within 0.25 s of FL.
  - Clicking a section on the timeline jumps FL there. FL's hint bar shows "Karta: shot 2 is ready".
  - Without Higgsfield keys it still shows the cover, the beat's DNA and the visualizer video.
  - When FL isn't open, the preview plays the rendered beat itself.

## Set up

```bash
npm install                       # repo root
npm run install-fl -w @karta/live # copies the script to Documents/Image-Line/FL Studio/Settings/Hardware/Karta Live
npm run login -w @karta/live      # Karta producer account + Higgsfield API key (saved to ~/Karta Live/config.json)
npm run live                      # opens http://localhost:4747
```

In FL Studio: **Options › MIDI settings**, pick any input port, and set **Controller type: Karta Live**.
If you have no controller, use a loopMIDI port (Windows) or the IAC Driver (Mac). The hint bar says
"Karta Live connected".

Export your beat (**File › Export › WAV**) into `~/Karta Live/Drop`. Karta Live picks it up, takes the title
from the FL project and the tempo from FL, and starts rendering. You can also drop a file on the window.

## Tests

```bash
npm test -w @karta/live
```

1. The FL script runs against stand-ins for FL's `transport`, `mixer`, `ui` and `general` modules.
2. An end-to-end run uses a simulated FL Studio running the real script, mock Higgsfield and Karta
   services that follow the documented request and status flow, and a WAV dropped into the Drop folder.
   It checks FL sync, seek and stop, every shot's queued → rendering → ready sequence, the cover reaching
   Higgsfield by public URL, the final cut, and the hint-bar messages.
