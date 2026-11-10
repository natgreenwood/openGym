/* What the app keeps of removed entries (`tombs`, NATG-561) on the server: PUT /api/data joins it
   with the stored copy for every writer (an app that does not know it cannot shrink it), caps it,
   ages it out at the server's time, and a reset starts over without it. Then the size of a
   document carrying as much of it as the cap allows, against the request body limit, and the
   three-device case the issue was found with, through the real server's revision/409 path in both
   reconnect orders, merged by the app's own code (frontend/src/lib/sync-merge.js; imported directly,
   as payload-parity.test.js does). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { stampPut, TOMB_MAX, TOMB_KEEP_MS } from '../sync-stamps.js';
import * as SS from '../sync-stamps.js';
import { markEntryUndone, mergeStates, stampChange, stampWorkout } from '../../frontend/src/lib/sync-merge.js';

const clone = v => JSON.parse(JSON.stringify(v));
const NOW = 1_800_000_000_000;
const DAY = 86400000;
const tomb = (id, note = 'n') => ({ _f: { note: NOW - 2000 }, note });
const stored = () => ({
  _ts: NOW - 1000, _rev: 3, workouts: [], routines: [],
  deleted: { workouts: { w1: NOW - 1500 }, routines: { r1: NOW - 1500 } },
  tombs: { workouts: { w1: tomb('w1') }, routines: { r1: tomb('r1') } },
});

test('the kept content is joined with the stored copy\'s for the app, an older app and a planner alike', () => {
  for (const opts of [{ stamped: true }, { stamped: false, overRead: true }, { stamped: false }]) {
    const next = { _ts: NOW, workouts: [], routines: [], deleted: { routines: { r2: NOW - 100 } }, tombs: { routines: { r2: tomb('r2') } } };
    if (!opts.stamped) delete next.tombs;   // an app from before it never sends one
    stampPut(stored(), next, { ...opts, now: NOW });
    assert.deepEqual(Object.keys(next.tombs.workouts), ['w1'], JSON.stringify(opts));
    assert.deepEqual(Object.keys(next.tombs.routines).sort(), opts.stamped ? ['r1', 'r2'] : ['r1'], JSON.stringify(opts));
  }
});

test('two versions of one key are joined field by field, not replaced', () => {
  const next = { _ts: NOW, workouts: [], deleted: { workouts: { w1: NOW - 1500 } },
    tombs: { workouts: { w1: { _f: { entries: NOW - 3000 }, entries: [{ id: 'bench', sets: [{ w: 60, r: 5 }] }] } } } };
  stampPut(stored(), next, { stamped: true, now: NOW });
  assert.deepEqual(next.tombs.workouts.w1, { _f: { entries: NOW - 3000, note: NOW - 2000 }, note: 'n', entries: [{ id: 'bench', sets: [{ w: 60, r: 5 }] }] });
});

test('a value of tombs that is not a map counts as nothing, and so does an entry that is not one', () => {
  for (const bad of ['x', 7, [1, 2], null, { workouts: [tomb('w9')] }, { workouts: { w9: 'x', w8: [] } }, { bodyweight: { d: tomb('d') } }]) {
    const next = { _ts: NOW, workouts: [], tombs: bad };
    stampPut(null, next, { stamped: true, now: NOW });
    assert.equal(next.tombs, undefined, JSON.stringify(bad));
    const joined = { _ts: NOW, workouts: [], deleted: clone(stored().deleted), tombs: bad };
    stampPut(stored(), joined, { stamped: true, now: NOW });
    assert.deepEqual(Object.keys(joined.tombs).sort(), ['routines', 'workouts'], JSON.stringify(bad));
  }
});

test('the server keeps the newest 200 per list, as the app does', () => {
  const tombs = { routines: {} }, del = { routines: {} };
  for (let i = 0; i < 230; i++) { const k = `r${String(i).padStart(3, '0')}`; tombs.routines[k] = tomb(k); del.routines[k] = NOW - 100000 + i; }
  const next = { _ts: NOW, routines: [], deleted: del, tombs };
  stampPut(null, next, { stamped: true, now: NOW });
  assert.equal(Object.keys(next.tombs.routines).length, TOMB_MAX);
  assert.ok(next.tombs.routines.r229 && !next.tombs.routines.r029);
});

test('content removed more than 30 days ago is aged out at the server\'s time, even from the stored copy', () => {
  const cur = stored();
  cur.deleted.routines.r1 = NOW - 31 * DAY;
  const next = { _ts: NOW, routines: [] };
  stampPut(cur, next, { stamped: true, now: NOW });
  assert.equal(TOMB_KEEP_MS, 30 * DAY);
  assert.deepEqual(Object.keys(next.tombs), ['workouts']);
});

test('content an entry back in its list already holds is let go of; content it lacks stays for the next app that merges it', () => {
  const back = { id: 'w1', d: '2026-10-01', start: 1, end: 2, note: 'n', _ts: NOW - 500, _f: { note: NOW - 2000 } };
  const merged = { _ts: NOW, workouts: [back], routines: [{ id: 'r1', name: 'Pull', _ts: NOW - 500 }], deleted: clone(stored().deleted) };
  stampPut(stored(), merged, { stamped: true, now: NOW });
  assert.deepEqual(Object.keys(merged.tombs), ['routines']);   // the routine came back without its note
  assert.deepEqual(Object.keys(merged.tombs.routines), ['r1']);
});

test('a reset starts over without the stored copy\'s kept content', () => {
  const next = { _ts: NOW, resetAt: NOW, resetIds: { workouts: ['w1'] }, workouts: [], routines: [] };
  stampPut(stored(), next, { stamped: true, now: NOW });
  assert.equal(next.tombs, undefined);
});

// ---- AC6: a document with as much kept content as the cap allows ------------------------------
const MAX_BODY = (() => {
  const src = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const m = /const MAX_BODY = ([\d\s*]+);/.exec(src);
  return m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1);
})();
const hex = i => crypto.createHash('sha256').update(String(i)).digest('hex');
const ref = i => ({ kind: 'image', hash: hex(i), mime: 'image/webp', size: 180000, width: 1080, height: 1440, poster: { hash: hex(`p${i}`), mime: 'image/webp', size: 9000, width: 180, height: 240 }, at: NOW - i });
// What a busy entry of each list holds in the fields an edit stamps: a full session's sets with a
// note and six photos, an eight-exercise routine, a custom exercise with its picture and link, a
// gym card, an equipment profile with its kit.
function heavyTomb(f, i) {
  const at = NOW - i * 1000;
  if (f === 'workouts') {
    const entries = Array.from({ length: 8 }, (_, e) => ({ id: `exercise-${e}`, note: 'felt heavy today, slow eccentric', sets: Array.from({ length: 5 }, (_, s) => ({ w: 102.5, r: 8, rir: 2, done: true, at: at + s * 90000, weightOrigin: 'plan' })) }));
    return { id: `w${i}`, _f: { entries: at, note: at, d: at, start: at, end: at, media: at }, entries, note: 'Long session. '.repeat(20), d: '2026-10-01', start: at - 3600000, end: at, media: Array.from({ length: 6 }, (_, m) => ref(`${i}-${m}`)) };
  }
  if (f === 'routines') {
    const ex = Array.from({ length: 8 }, (_, e) => ({ id: `exercise-${e}`, sets: 4, reps: 8, weight: 80, inc: 2.5, restSec: 120, prog: 'double', repsMin: 6, repsMax: 10, warmupSets: 2, note: 'pause at the bottom' }));
    return { id: `r${i}`, _f: { ex: at, name: at, note: at }, ex, name: `Upper body day ${i}`, note: 'Deload every fourth week. '.repeat(4) };
  }
  if (f === 'customEx') return { id: `c${i}`, _f: { name: at, media: at, url: at, note: at, bp: at }, name: `Sandbag carry ${i}`, media: ref(`c${i}`), url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', note: 'Hug the bag high. '.repeat(10), bp: 'back' };
  if (f === 'gymCards') return { id: `g${i}`, _f: { name: at, value: at, color: at, format: at }, name: `Gym ${i}`, value: '0123456789012345678901234567', color: '#22aa88', format: 'CODE_128' };
  return { id: `e${i}`, _f: { name: at, items: at }, name: `Home gym ${i}`, items: Array.from({ length: 40 }, (_, k) => `equipment-item-${k}`) };
}

test('a document carrying 200 busy kept entries in each of the five lists stays well under the body limit', t => {
  const doc = { _ts: NOW, unit: 'kg', workouts: [], routines: [], customEx: [], gymCards: [], equipProfiles: [], deleted: {}, tombs: {} };
  for (const f of ['workouts', 'routines', 'customEx', 'gymCards', 'equipProfiles']) {
    doc.deleted[f] = {}; doc.tombs[f] = {};
    for (let i = 0; i < TOMB_MAX + 20; i++) { const x = heavyTomb(f, i); doc.deleted[f][x.id] = NOW - i * 1000; doc.tombs[f][x.id] = x; }
  }
  stampPut(null, doc, { stamped: true, now: NOW });
  for (const f of Object.keys(doc.tombs)) assert.equal(Object.keys(doc.tombs[f]).length, TOMB_MAX, f);
  // and the byte budgets (SEC-01) let all of it through: nothing dropped, the same map
  assert.equal(SS.budgetTombs(doc.tombs, doc.deleted), doc.tombs);
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  const per = Object.fromEntries(Object.entries(doc.tombs).map(([f, m]) => [f, Buffer.byteLength(JSON.stringify(m))]));
  t.diagnostic(`MAX_BODY ${MAX_BODY} bytes; document with ${TOMB_MAX} kept entries per list: ${bytes} bytes (${(100 * bytes / MAX_BODY).toFixed(1)}%); per list ${JSON.stringify(per)}`);
  assert.equal(MAX_BODY, 5 * 1024 * 1024);
  assert.ok(bytes < MAX_BODY / 2, `${bytes} bytes is not well under ${MAX_BODY}`);
});

// ---- AC9 and AC10 against the real server ---------------------------------------------------
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
async function server(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-tombs-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u1', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } });
  let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const headers = { Cookie: `gymsid=${mintSession('u1')}`, 'Content-Type': 'application/json' };
  const put = async body => { const r = await fetch(`${base}/api/data`, { method: 'PUT', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const get = async () => (await fetch(`${base}/api/data`, { headers })).json();
  const stored = () => fs.statSync(path.join(dataDir, 'state-u1.json')).size;
  return { put, get, stored };
}
// The app's push (useStore pushState): against the revision it last read, and on a 409 its own
// copy merged with the server's (local first, as the store does) and pushed again.
async function push(api, S, rev) {
  let r = await api.put({ state: S, baseRev: rev, stamped: true });
  if (r.status === 409) r = await api.put({ state: mergeStates(clone(S), clone(r.body.state)), baseRev: r.body.rev, stamped: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}
const change = (prev, wall, mut) => { const n = clone(prev); mut(n); n._ts = stampChange(prev, n, wall); return n; };
const content = S => ({ workouts: S.workouts, routines: S.routines, deleted: S.deleted, tombs: S.tombs });

test('PUT /api/data: the watch, phone and server end up the same in both reconnect orders (B→A→C, B→C→A)', async t => {
  const T0 = Date.now() - 600000;
  const base0 = {
    _ts: T0, unit: 'kg', favEx: [], bodyweight: [],
    workouts: [{ id: 'w0', d: '2026-09-30', start: T0 - 7200000, end: T0 - 3600000, entries: [{ id: 'bench', sets: [{ w: 60, r: 5 }] }] }],
    routines: [{ id: 'r0', name: 'Push', ex: [{ id: 'bench', sets: 3 }], _ts: T0 - 5000 }],
  };
  const results = {};
  for (const order of ['BAC', 'BCA']) {
    const api = await server(t);
    const first = await api.put({ state: base0, stamped: true });
    assert.equal(first.status, 200);
    const seen = (await api.get()).state;
    const rev = first.body.rev;
    // B adds a set and renames the routine before the removal; C removes both; A writes a note on
    // the workout and the routine after it. Each worked offline on the copy all three last read.
    const B = change(seen, T0 + 1000, S => { S.workouts[0].entries[0].sets.push({ w: 20, r: 1 }); stampWorkout(S.workouts[0], T0 + 1000); S.routines[0].name = 'Push day' });
    const C = change(seen, T0 + 2000, S => { S.workouts = []; S.routines = [] });
    const A = change(seen, T0 + 3000, S => { S.workouts[0].note = 'keep this note'; stampWorkout(S.workouts[0], T0 + 3000); S.routines[0].note = 'heavy' });
    const by = { A, B, C };
    for (const id of order) await push(api, by[id], rev);
    results[order] = (await api.get()).state;
  }
  const { BAC, BCA } = results;
  assert.deepEqual(content(BAC), content(BCA));
  assert.equal(BAC.workouts[0].note, 'keep this note');
  assert.deepEqual(BAC.workouts[0].entries[0].sets, [{ w: 60, r: 5 }, { w: 20, r: 1 }]);
  assert.equal(BAC.routines[0].name, 'Push day');
  assert.equal(BAC.routines[0].note, 'heavy');
});

test('PUT /api/data: an older app and a current one keep the kept content, and nothing removed comes back', async t => {
  const api = await server(t);
  const T0 = Date.now() - 600000;
  const doc = {
    _ts: T0, unit: 'kg', workouts: [{ id: 'w2', d: '2026-10-02', start: T0 - 9000, end: T0 - 8000 }], routines: [],
    deleted: { workouts: { w1: T0 - 1000 } }, tombs: { workouts: { w1: { _f: { note: T0 - 2000 }, note: 'kept' } } },
  };
  let r = await api.put({ state: doc, stamped: true });
  assert.equal(r.status, 200);
  // v1.3.9 read the profile, knows neither `deleted` nor `tombs`, and pushes back over that revision.
  const old = clone((await api.get()).state);
  delete old.deleted; delete old.tombs; delete old.edited; old._ts = T0 + 1000;
  r = await api.put({ state: old, baseRev: r.body.rev });
  assert.equal(r.status, 200);
  // The current release stamps its changes but does not know `tombs` either: its copy has none.
  const cur = clone((await api.get()).state);
  delete cur.tombs; cur._ts = T0 + 2000;
  r = await api.put({ state: cur, baseRev: r.body.rev, stamped: true });
  assert.equal(r.status, 200);
  const after = (await api.get()).state;
  assert.deepEqual(after.tombs, doc.tombs);
  assert.deepEqual(after.workouts.map(w => w.id), ['w2']);
  assert.ok(after.deleted.workouts.w1 > 0);
});

// NATG-561 Tester finding 1 (natg-561-undo-repro.mjs): B removes the bench exercise and then the
// routine; C makes it four sets; A removes the exercise and puts it back with Undo. The Undo never
// saw either change, both made inside its window, so the later of them (C's) is what comes back,
// in both reconnect orders. Before, B→A→C restored the routine with no exercise.
test('PUT /api/data: an Undo two unseen changes overrule keeps the later one in both reconnect orders (B→A→C, B→C→A)', async t => {
  const T = Date.now() - 600000;
  const base0 = { _ts: T + 10, unit: 'kg', workouts: [], routines: [{ id: 'r', name: 'Push', ex: [{ id: 'bench', sets: 3 }], _ts: T + 10 }] };
  const copies = S0 => {
    const at = (S, t, mut) => change(S, T + t, mut);
    const a0 = at(S0, 130, x => { x.routines[0].ex = []; });
    const A = at(a0, 160, x => {
      x.routines[0].ex = clone(S0.routines[0].ex);
      markEntryUndone(x.routines[0], 'ex', S0.routines[0]._f?.ex || 0, T + 130);
    });
    const B = at(at(S0, 100, x => { x.routines[0].ex = []; }), 120, x => { x.routines = []; });
    const C = at(S0, 110, x => { x.routines[0].ex[0].sets = 4; });
    return { A, B, C };
  };
  const results = {};
  for (const order of ['BAC', 'BCA']) {
    const api = await server(t);
    const first = await api.put({ state: base0, stamped: true });
    assert.equal(first.status, 200);
    const by = copies((await api.get()).state);
    for (const id of order) await push(api, by[id], first.body.rev);
    results[order] = (await api.get()).state;
  }
  const { BAC, BCA } = results;
  assert.deepEqual(BAC.routines, BCA.routines);
  assert.deepEqual(BAC.routines[0].ex, [{ id: 'bench', sets: 4 }]);
  assert.deepEqual(BAC.routines[0]._u, { ex: [0, T + 130, T + 161, T + 110] });
});

// ---- NATG-561 SEC-01: the bytes kept, not only the number of entries -----------------------------
// The budgets below are written out as numbers on purpose: these regressions must fail against a
// server that has none (31b83f236), not on a missing import.
const KIB = 1024, MIB = 1024 * 1024;
test('the byte budgets are the measured ones, the same as the app\'s', () => {
  assert.equal(SS.TOMB_BYTES_MAX, 64 * KIB);
  assert.equal(SS.TOMBS_BYTES_MAX, 2.5 * MIB);
});

test('a kept entry over its byte budget goes whole; the others stay', () => {
  const next = { _ts: NOW, routines: [], deleted: { routines: { big: NOW - 10, small: NOW - 20 } },
    tombs: { routines: { big: { _f: { note: NOW - 30 }, note: 'x'.repeat(70 * KIB) }, small: { _f: { note: NOW - 30 }, note: 'kept' } } } };
  stampPut(null, next, { stamped: true, now: NOW });
  assert.deepEqual(Object.keys(next.tombs.routines), ['small']);
});

test('past the total budget whole entries go, the oldest removal first, ties by key', () => {
  const tombs = { routines: {}, customEx: {} }, del = { routines: {}, customEx: {} };
  for (let i = 0; i < 60; i++) {
    const f = i % 2 ? 'routines' : 'customEx', k = `k${String(i).padStart(2, '0')}`;
    tombs[f][k] = { _f: { note: NOW - 50 }, note: 'y'.repeat(60 * KIB) };
    del[f][k] = NOW - 1000 + Math.floor(i / 4);   // groups of four with the same removal stamp
  }
  const next = { _ts: NOW, routines: [], customEx: [], deleted: del, tombs };
  stampPut(null, next, { stamped: true, now: NOW });
  const left = [...Object.keys(next.tombs.routines || {}), ...Object.keys(next.tombs.customEx || {})].sort();
  assert.ok(Buffer.byteLength(JSON.stringify(next.tombs)) <= 2.5 * MIB);
  assert.equal(left.length, 42);                       // 42 entries of about 61 KiB fit 2.5 MiB
  assert.deepEqual(left, Array.from({ length: 42 }, (_, i) => `k${String(i + 18).padStart(2, '0')}`));
});

test('PUT /api/data: pushes under the request limit adding a fresh 1 MiB field to one kept entry do not grow the stored document (SEC-01)', async t => {
  const api = await server(t);
  const T = Date.now() - 60000;
  let rev = null;
  for (let i = 0; i < 8; i++) {
    const tomb = { _f: { [`p${i}`]: T }, [`p${i}`]: 'a'.repeat(MIB) };
    const r = await api.put({ state: { _ts: T + i, workouts: [], routines: [], deleted: { routines: { r: T } }, tombs: { routines: { r: tomb } } }, stamped: true, ...(rev != null ? { baseRev: rev } : {}) });
    assert.equal(r.status, 200);
    rev = r.body.rev;
    assert.ok(api.stored() < 64 * KIB, `stored ${api.stored()} bytes after push ${i + 1}`);
  }
  // fields just under the per-entry budget: two of them joined are over it, and the entry goes whole
  for (let i = 0; i < 6; i++) {
    const tomb = { _f: { [`q${i}`]: T }, [`q${i}`]: 'b'.repeat(40 * KIB) };
    const r = await api.put({ state: { _ts: T + 10 + i, workouts: [], routines: [], deleted: { routines: { r: T } }, tombs: { routines: { r: tomb } } }, stamped: true, baseRev: rev });
    assert.equal(r.status, 200);
    rev = r.body.rev;
    const kept = (await api.get()).state.tombs?.routines?.r;
    assert.ok(!kept || Buffer.byteLength(JSON.stringify(kept)) <= 64 * KIB);
  }
  assert.ok(api.stored() < 64 * KIB);
});

test('PUT /api/data: the same across many keys stays within the total budget, newest removals kept (SEC-01)', async t => {
  const api = await server(t);
  const T = Date.now() - 600000;
  let rev = null, n = 0;
  for (let i = 0; i < 6; i++) {
    const tombs = { routines: {} }, del = { routines: {} };
    for (let j = 0; j < 30; j++, n++) {
      const k = `r${String(n).padStart(3, '0')}`;
      tombs.routines[k] = { _f: { note: T }, note: 'c'.repeat(60 * KIB) };
      del.routines[k] = T + n;
    }
    const r = await api.put({ state: { _ts: T + i, workouts: [], routines: [], deleted: del, tombs }, stamped: true, ...(rev != null ? { baseRev: rev } : {}) });
    assert.equal(r.status, 200);
    rev = r.body.rev;
    assert.ok(api.stored() < 2.5 * MIB + 64 * KIB, `stored ${api.stored()} bytes after push ${i + 1}`);
  }
  const kept = Object.keys((await api.get()).state.tombs.routines).sort();
  assert.equal(kept.at(-1), 'r179');                   // the newest removal is still kept
  assert.ok(kept.length < 180 && kept.length >= 40);
});
