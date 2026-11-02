// Chunked uploads + Range streaming through MediaStore, and "Continue with STRDM" against a mock STRDM backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const API = process.env.API ?? 'http://localhost:8787';
const run = Date.now().toString(36);
let mock;

before(async () => {
  mock = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const { email, password } = JSON.parse(b || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/auth/login' && password === 'strdm-pass') { res.end(JSON.stringify({ ok: true, token: 'strdm_tok', user: { id: 'su_1', email, name: 'Armanii Test' } })); return; }
      res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Invalid email or password' }));
    });
  }).listen(8799);
});
after(() => mock.close());

const j = (r) => r.json();
const post = (path, body, token) => fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await j(r)) }));

test('Continue with STRDM: wrong password, first-time profile step, then linked sign-in', async () => {
  const email = `armanii${run}@strdm.io`;
  const bad = await post('/auth/strdm', { email, password: 'nope' });
  assert.equal(bad.status, 401);
  assert.match(bad.error, /Invalid email or password/);
  const first = await post('/auth/strdm', { email, password: 'strdm-pass' });
  assert.equal(first.data.needsProfile, true);
  assert.ok(first.data.suggestedHandle.length >= 3);
  const made = await post('/auth/strdm', { email, password: 'strdm-pass', role: 'buyer', handle: `armanii${run}` });
  assert.equal(made.data.me.role, 'buyer');
  assert.equal(made.data.me.name, 'Armanii Test');
  const again = await post('/auth/strdm', { email, password: 'strdm-pass' });
  assert.ok(again.data.token && !again.data.needsProfile, 'existing account signs straight in');
  const pw = await post('/auth/login', { email, password: 'anything' });
  assert.match(pw.error, /signs in with STRDM/);
});

test('9 MB file uploads in 4 MB parts and streams back with Range', async () => {
  const p = await post('/auth/signup', { email: `big${run}@example.com`, password: 'big-12345', name: 'Big Files', handle: `big${run}`, role: 'producer' });
  const token = p.data.token;
  const beat = (await post('/studio/beats', { title: 'Trackout Test', bpm: 140 }, token)).data;
  const size = 9 * 1024 * 1024 + 123;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7) % 251;
  const PART = 4_000_000;
  let last;
  for (let n = 0; n * PART < size; n++) {
    const r = await fetch(`${API}/studio/beats/${beat.id}/files/preview`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/mpeg', 'X-Upload-Size': String(size), 'X-Upload-Part': String(n) },
      body: data.slice(n * PART, (n + 1) * PART),
    });
    last = await r.json();
    assert.equal(r.status, 200, JSON.stringify(last));
  }
  assert.ok(last.data.files.includes('preview'), 'beat records the file once complete');
  const ranged = await fetch(`${API}/media/beats/${beat.id}/preview`, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=4999990-5000009' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 4999990-5000009/${size}`);
  const got = new Uint8Array(await ranged.arrayBuffer());
  assert.deepEqual([...got], [...data.slice(4999990, 5000010)]);
  const full = new Uint8Array(await (await fetch(`${API}/media/beats/${beat.id}/preview`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
  assert.equal(full.length, size);
  assert.equal(full[size - 1], data[size - 1]);
  const anon = await fetch(`${API}/media/beats/${beat.id}/preview`);
  assert.equal(anon.status, 404, 'draft previews are private');
});
