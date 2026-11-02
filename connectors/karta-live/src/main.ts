#!/usr/bin/env node
// karta-live            start the preview (http://localhost:4747)
// karta-live install    put the FL Studio script in place and print the FL setup steps
// karta-live login      save your Karta session + Higgsfield keys to ~/Karta Live/config.json
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { exec } from 'node:child_process';

import { defaultScriptDir, installScript } from './fl.js';
import { loadConfig, startServer } from './server.js';

const cmd = process.argv[2] ?? 'start';

if (cmd === 'install') {
  const target = installScript(process.argv[3] ?? defaultScriptDir());
  console.log(`Installed the FL Studio script:\n  ${target}\n`);
  console.log('In FL Studio:');
  console.log('  1. Options > MIDI settings.');
  console.log('  2. Under Input, pick any port. No controller? Install loopMIDI (Windows) or turn on the IAC Driver (Mac) and pick that.');
  console.log('  3. Set Controller type to "Karta Live" and make sure the port is enabled.');
  console.log('  4. The hint bar says "Karta Live connected". Then run: karta-live');
} else if (cmd === 'login') {
  const cfg = loadConfig();
  const rl = createInterface({ input: stdin, output: stdout });
  const api = (await rl.question('Karta API URL [https://karta-backend.rork.app]: ')) || 'https://karta-backend.rork.app';
  const email = await rl.question('Karta email: ');
  const password = await rl.question('Karta password: ');
  const keyId = await rl.question('Higgsfield API key ID (blank to skip): ');
  const keySecret = keyId ? await rl.question('Higgsfield API key secret: ') : '';
  rl.close();
  const res = await fetch(`${api.replace(/\/$/, '')}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = (await res.json()) as { ok: boolean; data?: { token: string; me: { role: string; name: string } }; error?: string };
  if (!j.ok || !j.data) { console.error(j.error ?? 'Sign-in failed'); process.exit(1); }
  if (j.data.me.role !== 'producer') console.warn('Heads up: only producer accounts can host files for Higgsfield.');
  let prev: Record<string, unknown> = {};
  try { prev = JSON.parse(readFileSync(join(cfg.home, 'config.json'), 'utf8')); } catch { /* new */ }
  writeFileSync(join(cfg.home, 'config.json'), JSON.stringify({ ...prev, kartaApi: api, kartaToken: j.data.token, ...(keyId ? { higgsfieldKeyId: keyId, higgsfieldKeySecret: keySecret } : {}) }, null, 2), { mode: 0o600 });
  console.log(`Signed in as ${j.data.me.name}. Saved to ${join(cfg.home, 'config.json')}`);
} else if (cmd === 'start') {
  const cfg = loadConfig();
  const live = startServer(cfg);
  const url = `http://localhost:${cfg.port}`;
  console.log(`Karta Live is running at ${url}`);
  console.log(`FL Studio script folder: ${live.fl.dir}${live.fl.installed ? '' : '  (not installed yet: run karta-live install)'}`);
  console.log(`Export a WAV from FL into ${join(cfg.home, 'Drop')} and Karta Live renders it automatically.`);
  if (!cfg.higgsfield) console.log('Higgsfield keys not set: you get the cover, DNA and visualizer. Run karta-live login to add them.');
  if (process.argv.includes('--open')) exec(`${process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'} ${url}`);
} else {
  console.log('Usage: karta-live [start|install|login]');
}
