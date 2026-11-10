#!/usr/bin/env node
// The NATG-494 perf check (AC5): what heavy shared routines cost an unrelated user's poll.
//
//   node scripts/shared-poll-load.mjs [--api <dir>] [--seconds 10] [--routine over|under]
//
// Ten sharers, each with a state document at the 5 MB PUT limit, each share one routine with
// their own recipient, accepted. The ten recipients poll GET /api/data/rev back to back, all at
// once, while one more user who shares nothing polls it every 25 ms; the script prints that
// user's latencies, then the same with no load for comparison. `--routine over` (the default)
// makes each shared routine nearly the whole document, the shape the security review measured;
// `under` keeps it just inside the 64 KiB cap and fills the rest of the document with workouts.
// `--api` points at another checkout's api/ directory, to measure a build without the cap.
//
// Not part of `npm test`: the timings depend on the machine and on whatever else runs on it, so
// the test suite checks the cause instead (no projection or hash per poll, NATG-494 tests in
// test/server-shares-projection.test.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const API = path.resolve(arg('api', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const SECONDS = +arg('seconds', 10);
const SHAPE = arg('routine', 'over');
const SHARERS = 10, DOC_BYTES = 5 * 1024 * 1024 - 64 * 1024;

const SECRET = crypto.randomBytes(32).toString('hex');
const session = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const slot = i => ({ id: String(i % 9000).padStart(4, '0'), sets: 3, reps: 10, weight: 60 + (i % 40), note: 'n'.repeat(900) });
// A sharer's document of about DOC_BYTES, its routine r1 over or just under the cap.
function sharerDoc(n) {
  const S = { unit: 'kg', _rev: 3, lang: 'en', routines: [], workouts: [] };
  if (SHAPE === 'over') {
    const ex = [];
    while (ex.length * 960 < DOC_BYTES) ex.push(slot(ex.length + n));
    S.routines.push({ id: 'r1', name: `Big ${n}`, ex });
  } else {
    S.routines.push({ id: 'r1', name: `Fit ${n}`, ex: Array.from({ length: 60 }, (_, i) => slot(i + n)) });
    const workout = i => ({ id: `w${i}`, d: '2026-01-01', name: 'Session', entries: [{ id: '0001', sets: [{ w: 60, r: 10 }] }], note: 'w'.repeat(800) });
    const each = JSON.stringify(workout(99999)).length + 1;
    const room = DOC_BYTES - JSON.stringify(S).length;
    for (let i = 0; i < room / each; i++) S.workouts.push(workout(i));
  }
  return S;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-share-load-'));
const now = new Date().toISOString();
const users = [{ id: 'u_other', name: 'Other', created: now }];
const shares = [];
for (let n = 0; n < SHARERS; n++) {
  users.push({ id: `u_from${n}`, name: `From ${n}`, created: now }, { id: `u_to${n}`, name: `To ${n}`, created: now });
  shares.push({ id: crypto.randomBytes(8).toString('hex'), from: `u_from${n}`, to: `u_to${n}`, routineId: 'r1', state: 'accepted', created: now, acceptedAt: now });
  fs.writeFileSync(path.join(dataDir, `state-u_from${n}.json`), JSON.stringify(sharerDoc(n)));
  fs.writeFileSync(path.join(dataDir, `state-u_to${n}.json`), JSON.stringify({ unit: 'kg', _rev: 1, routines: [] }));
}
fs.writeFileSync(path.join(dataDir, 'state-u_other.json'), JSON.stringify({ unit: 'kg', _rev: 1, routines: [] }));
fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  users, creds: [], subs: [], invites: [], shares, settings: { routineSharing: { enabledAt: now, by: 'u_other' } }
}));
const docMB = fs.statSync(path.join(dataDir, 'state-u_from0.json')).size / 1048576;

const child = spawn(process.execPath, ['server.js'], {
  cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
});
let log = '';
child.stderr.on('data', d => { log += d; });
const port = await new Promise((resolve, reject) => {
  let seen = '';
  child.stdout.on('data', d => { seen += d; const m = /gym-api on :(\d+)/.exec(seen); if (m) resolve(+m[1]); });
  child.once('exit', code => reject(new Error(`server exited (${code}):\n${seen}${log}`)));
});
// The child's pipes keep this process alive, so it is stopped by hand, on every way out.
const cleanup = () => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const poll = async uid => {
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${port}/api/data/rev`, { headers: { Cookie: `gymsid=${session(uid)}` } });
  await r.arrayBuffer();
  if (r.status !== 200) throw new Error(`${uid}: ${r.status}`);
  return performance.now() - t0;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sampleOther(ms) {
  const out = [];
  for (const end = Date.now() + ms; Date.now() < end;) { out.push(await poll('u_other')); await sleep(25); }
  return out;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const show = (label, xs) => console.log(`${label}: n=${xs.length} p50=${pct(xs, 50).toFixed(1)} ms p95=${pct(xs, 95).toFixed(1)} ms max=${Math.max(...xs).toFixed(1)} ms`);

// Warm: every document read once, so the numbers are the steady state a poll every 30 s sees.
for (let n = 0; n < SHARERS; n++) await poll(`u_to${n}`);
await sampleOther(1000);

const idle = await sampleOther(SECONDS * 500);
let running = true, recipientPolls = 0;
const recipient = async uid => { while (running) { await poll(uid); recipientPolls++; } };
const load = Array.from({ length: SHARERS }, (_, n) => recipient(`u_to${n}`));
const loaded = await sampleOther(SECONDS * 1000);
running = false;
await Promise.all(load);

console.log(`api: ${API}`);
console.log(`${SHARERS} sharers, documents ${docMB.toFixed(2)} MB each, shared routine ${SHAPE === 'over' ? 'over' : 'under'} the cap; ${SECONDS} s`);
show('unrelated poll, idle  ', idle);
show('unrelated poll, loaded', loaded);
console.log(`recipient polls under load: ${recipientPolls} (${(recipientPolls / SECONDS).toFixed(0)}/s)`);
process.exit(0);
