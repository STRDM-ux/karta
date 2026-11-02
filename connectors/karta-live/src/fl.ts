// The FL Studio side of Karta Live: find FL's script folder, install the script, follow
// karta_state.json and send commands through karta_cmd.json.
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, copyFileSync, type FSWatcher } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FLState {
  app: 'fl-studio'; title: string; playing: boolean; recording: boolean; loopMode: number;
  tempo: number; ppq: number; posMs: number; posTicks: number; songMs: number; hint: string;
  unsaved: boolean; seq: number; at: number; closed?: boolean; flVersion?: string;
}

export type FLCommand = { type: 'seek'; ms: number } | { type: 'play' } | { type: 'stop' } | { type: 'toggle' } | { type: 'hint'; text: string };

/** FL Studio keeps user scripts in Documents/Image-Line/FL Studio/Settings/Hardware on Windows and macOS. */
export function defaultScriptDir(): string {
  const docs = process.env.KARTA_FL_DOCUMENTS ?? join(homedir(), 'Documents');
  return join(docs, 'Image-Line', 'FL Studio', 'Settings', 'Hardware', 'Karta Live');
}

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPT_SOURCE = resolve(here, '..', '..', 'fl-studio', 'Karta Live', 'device_KartaLive.py');

export function installScript(dir = defaultScriptDir()): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'device_KartaLive.py');
  copyFileSync(SCRIPT_SOURCE, target);
  return target;
}

/** Follows the state file the FL script writes. FL counts as connected while the file keeps updating. */
export class FLBridge {
  state: FLState | null = null;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastSeq = -1;
  private listeners = new Set<(s: FLState | null, connected: boolean) => void>();

  constructor(readonly dir = defaultScriptDir()) {}

  get stateFile() { return join(this.dir, 'karta_state.json'); }
  get cmdFile() { return join(this.dir, 'karta_cmd.json'); }
  get installed() { return existsSync(join(this.dir, 'device_KartaLive.py')); }

  /** Connected = the script wrote within the last 3 s (it heartbeats every second) and FL isn't closing. */
  get connected(): boolean {
    return !!this.state && !this.state.closed && Date.now() - this.state.at < 3000;
  }

  on(fn: (s: FLState | null, connected: boolean) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  start() {
    mkdirSync(this.dir, { recursive: true });
    const read = () => {
      try {
        const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as FLState;
        if (s.seq === this.lastSeq && s.at === this.state?.at) return;
        this.lastSeq = s.seq;
        this.state = s;
        for (const fn of this.listeners) fn(s, this.connected);
      } catch { /* not written yet, or mid-replace */ }
    };
    try { this.watcher = watch(this.dir, (_e, f) => { if (f === 'karta_state.json') read(); }); } catch { /* some network drives can't be watched */ }
    // fs.watch misses events on some systems; a light poll keeps the playhead smooth and notices FL closing
    let wasConnected = false;
    this.poll = setInterval(() => {
      read();
      const c = this.connected;
      if (c !== wasConnected) { wasConnected = c; for (const fn of this.listeners) fn(this.state, c); }
    }, 50);
    read();
  }

  stop() { this.watcher?.close(); if (this.poll) clearInterval(this.poll); }

  /** Queues commands; the script reads and deletes the file within ~100 ms. */
  send(...cmds: FLCommand[]) {
    let queue: FLCommand[] = [];
    try { const prev = JSON.parse(readFileSync(this.cmdFile, 'utf8')); queue = Array.isArray(prev) ? prev : [prev]; } catch { /* none pending */ }
    queue.push(...cmds);
    const tmp = this.cmdFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(queue.slice(-20)));
    renameSync(tmp, this.cmdFile);
  }
}

export const isMac = () => platform() === 'darwin';
