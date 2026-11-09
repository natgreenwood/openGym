/* Routine sharing, slice two (NATG-487): the projection and the read path. An accepted share is
   resolved at read time from the sharer's own document; GET /api/data/rev carries a cheap
   `shares` etag that never writes; PUT /api/data keeps shared copies out and drops the shares of
   a routine its owner deleted; a routine that gained a custom exercise is hidden, not revoked;
   and a day whose only routine is a shared one is a training day for the reminder tick, the
   nudge and GET /api/nudge-check. Real server.js in a child, same harness as
   server-shares.test.js. Each test names the NATG-487 acceptance criterion it covers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, logLine, stackFrames, stderrSettled } from './helpers.mjs';
import { contentHash } from '../shared-routine.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ORIGIN = 'http://localhost:8080';
const ADMIN = 'u_adm', ALEX = 'u_alex', SAM = 'u_sam', KIM = 'u_kim';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: ORIGIN });

// Alex shares r1 (with sync bookkeeping and a planned backup on its slot) and r2. Alex trains in
// lb; Sam, the recipient, in kg. Everything else in Alex's document must stay on the server.
const alexState = (over = {}) => ({
  unit: 'lb', _rev: 7, lang: 'en',
  routines: [
    { id: 'r1', name: 'Push A', emoji: '💪', _ts: 5, _f: { name: 5 }, _u: 1, notes: 'private', prog: { kind: 'linear' },
      ex: [{ id: '0001', sets: 3, reps: 10, weight: 95, _ts: 5, _f: { weight: 5 }, subs: ['0002'] }, { id: '0003', sets: 2, mode: 'time', sec: 45 }] },
    { id: 'r2', name: 'Pull A', ex: [{ id: '0004', sets: 3 }] }
  ],
  customEx: [{ id: 'c_mine', name: 'My move' }],
  workouts: [{ id: 'w1', d: '2026-09-01', name: 'Secret session', entries: [] }],
  bodyweight: [{ d: '2026-09-01', kg: 80 }],
  ...over
});

async function startServer(t, { sharing = true, shares = [], alex = alexState(), sam = { unit: 'kg', _rev: 2, routines: [] }, subs = [], env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-shares-proj-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ADMIN, name: 'Adminna', created: now, admin: true },
      { id: ALEX, name: 'Alex', created: now },
      { id: SAM, name: 'Sam', created: now },
      { id: KIM, name: 'Kim', created: now }
    ],
    creds: [], subs, invites: [], shares,
    ...(sharing ? { settings: { routineSharing: { enabledAt: now, by: ADMIN } } } : {})
  }));
  const file = uid => path.join(dataDir, `state-${uid}.json`);
  fs.writeFileSync(file(ALEX), JSON.stringify(alex));
  if (sam) fs.writeFileSync(file(SAM), JSON.stringify(sam));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1', ...env }
  });
  const h = { log: '', dataDir, child };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.call = async (method, route, uid, body) => {
    const r = await fetch(`${h.api}${route}`, {
      method, headers: uid ? as(uid) : { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: r.status, body: await r.json() };
  };
  h.get = (route, uid) => h.call('GET', route, uid);
  h.post = (route, uid, body) => h.call('POST', route, uid, body);
  h.del = (route, uid) => h.call('DELETE', route, uid);
  h.share = (uid, routineId, to) => h.post('/api/shares', uid, { routineId, to });
  h.accept = (id, uid) => h.post(`/api/shares/${id}/accept`, uid);
  h.incoming = async uid => (await h.get('/api/shares', uid)).body.incoming;
  h.etag = async uid => (await h.get('/api/data/rev', uid)).body.shares;
  // A whole-document write, as an older app or a script makes it: no baseRev, overwrites.
  h.put = (uid, state) => h.call('PUT', '/api/data', uid, { state });
  h.read = uid => JSON.parse(fs.readFileSync(file(uid), 'utf8'));
  h.write = (uid, state) => fs.writeFileSync(file(uid), typeof state === 'string' ? state : JSON.stringify(state));
  h.dbBytes = () => fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  h.db = () => JSON.parse(h.dbBytes());
  h.audit = () => {
    try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
  };
  h.stackFrames = () => stackFrames(child, h.api, () => h.log);
  h.settled = () => stderrSettled(child, h.api, () => h.log);
  return h;
}
// An accepted share of Alex's `routineId` for Sam, and its id.
async function acceptedShare(h, routineId = 'r1', to = SAM) {
  const [s] = (await h.share(ALEX, routineId, [to])).body.shares;
  assert.equal((await h.accept(s.id, to)).status, 200);
  return s.id;
}
// The stat cache keys on mtime and size: a rewrite of the same length inside one mtime tick could
// read back as the old document. Writes through PUT evict it; a test's direct write waits a tick.
const tick = () => new Promise(r => setTimeout(r, 30));

/* ---------- AC1: the projection ---------- */

test('AC1: an accepted share carries the sharer\'s current whitelisted routine, their unit and its hash; nothing else leaves', async t => {
  const h = await startServer(t);
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const acc = await h.accept(s.id, SAM);
  const item = (await h.incoming(SAM))[0];
  assert.deepEqual(acc.body.share, item, 'accept answers with the same item GET /api/shares lists');
  assert.deepEqual(Object.keys(item).sort(), ['acceptedAt', 'created', 'from', 'hash', 'id', 'routine', 'state', 'unit']);
  assert.equal(item.state, 'accepted');
  assert.deepEqual(item.from, { id: ALEX, name: 'Alex' });
  assert.equal(item.unit, 'lb', "the sharer's unit; the client converts on the way in");
  assert.match(item.hash, /^[0-9a-f]{16}$/);
  assert.equal(item.hash, contentHash({ unit: item.unit, routine: item.routine }), 'a hash of exactly what the item shows');
  assert.equal(JSON.stringify(item).includes('"rev"'), false, "the sharer's document revision is never exposed");
  // The plan export's routine fields, no sync bookkeeping, no planned backups, no private note.
  assert.deepEqual(item.routine, {
    id: 'r1', name: 'Push A', emoji: '💪', prog: { kind: 'linear' },
    ex: [{ id: '0001', sets: 3, reps: 10, weight: 95 }, { id: '0003', sets: 2, mode: 'time', sec: 45 }]
  });
  const text = JSON.stringify(await h.get('/api/shares', SAM));
  for (const secret of ['Secret session', 'private', 'My move', 'c_mine', 'bodyweight', 'Pull A']) {
    assert.equal(text.includes(secret), false, `"${secret}" stays on the server`);
  }
  // A sharer with no unit set is kg.
  h.write(ALEX, alexState({ unit: undefined, _rev: 8 }));
  await tick();
  assert.equal((await h.incoming(SAM))[0].unit, 'kg');
});

test('AC1: a pending item carries only the name-and-count preview, with its hash', async t => {
  const h = await startServer(t);
  await h.share(ALEX, 'r1', [SAM]);
  const [p] = await h.incoming(SAM);
  assert.deepEqual(Object.keys(p).sort(), ['created', 'from', 'hash', 'id', 'preview', 'state']);
  assert.equal(p.state, 'pending');
  assert.deepEqual(p.preview, { name: 'Push A', exercises: 2 });
  assert.equal(p.hash, contentHash({ preview: p.preview }));
});

test('AC1: the projection follows the sharer\'s edits on the next read', async t => {
  const h = await startServer(t);
  await acceptedShare(h);
  const before = (await h.incoming(SAM))[0].hash;
  const edited = alexState();
  edited.routines[0].name = 'Push B';
  edited.routines[0].ex.push({ id: '0005', sets: 4 });
  assert.equal((await h.put(ALEX, edited)).status, 200);
  const item = (await h.incoming(SAM))[0];
  assert.equal(item.routine.name, 'Push B');
  assert.equal(item.routine.ex.length, 3);
  assert.notEqual(item.hash, before);
});

/* ---------- AC2: the etag on the revision poll ---------- */

test('AC2: GET /api/data/rev carries the shares etag while sharing is on, the same one GET /api/shares answers', async t => {
  const off = await startServer(t, { sharing: false });
  assert.equal('shares' in (await off.get('/api/data/rev', SAM)).body, false, 'no key while sharing is off');

  const h = await startServer(t);
  const empty = await h.get('/api/data/rev', SAM);
  assert.deepEqual(Object.keys(empty.body).sort(), ['rev', 'shares'], 'the poll stays a few bytes: no list, no body');
  assert.match(empty.body.shares, /^[0-9a-f]{16}$/);
  await acceptedShare(h);
  const poll = await h.get('/api/data/rev', SAM);
  assert.equal(poll.body.shares, (await h.get('/api/shares', SAM)).body.etag);
  assert.equal(poll.body.rev, 2, "the recipient's own revision is untouched");
  assert.notEqual(poll.body.shares, empty.body.shares);
});

test('AC2: the etag moves when the sharer edits a shared routine and when the recipient\'s list changes, and only then', async t => {
  const h = await startServer(t);
  const e0 = await h.etag(SAM);
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const e1 = await h.etag(SAM);
  assert.notEqual(e1, e0, 'a new share');
  // A rename while the share waits moves it: pending items carry a hash of the preview.
  const renamed = alexState(); renamed.routines[0].name = 'Push renamed';
  await h.put(ALEX, renamed);
  const e2 = await h.etag(SAM);
  assert.notEqual(e2, e1, 'an edit while pending');
  assert.equal((await h.incoming(SAM))[0].preview.name, 'Push renamed');
  await h.accept(s.id, SAM);
  const e3 = await h.etag(SAM);
  assert.notEqual(e3, e2, 'accepted');
  assert.equal(await h.etag(SAM), e3, 'stable while nothing changes');
  await h.put(ALEX, alexState({ unit: 'kg' }));
  const e4 = await h.etag(SAM);
  assert.notEqual(e4, e3, "the sharer's edit");
  // Sam's own writes are Sam's revision, not the shares etag.
  await h.put(SAM, { unit: 'kg', routines: [], week: { 1: [`shared:${s.id}`] } });
  assert.equal(await h.etag(SAM), e4);
  // Another recipient's answer is not Sam's business.
  const [k] = (await h.share(ALEX, 'r1', [KIM])).body.shares;
  await h.post(`/api/shares/${k.id}/decline`, KIM);
  assert.equal(await h.etag(SAM), e4);
  await h.del(`/api/shares/${s.id}`, ALEX);
  assert.notEqual(await h.etag(SAM), e4, 'revoked');
});

// The NATG-487 review: the version tag is a hash of what the recipient sees, never the sharer's
// document revision, so nothing else the sharer syncs reaches a recipient.
test('AC2: the sharer logging a workout or editing a routine that is not shared moves neither the etag nor the hash', async t => {
  const h = await startServer(t);
  await acceptedShare(h);
  const etag = await h.etag(SAM);
  const hash = (await h.incoming(SAM))[0].hash;
  const trained = alexState({ workouts: [...alexState().workouts, { id: 'w2', d: '2026-09-02', name: 'Pull day', entries: [] }] });
  assert.equal((await h.put(ALEX, trained)).status, 200);
  const other = alexState({ workouts: trained.workouts });
  other.routines[1].name = 'Pull B';
  other.routines[1].ex[0].sets = 5;
  assert.equal((await h.put(ALEX, other)).status, 200);
  // The same routine with its keys written in another order (another client) is the same content.
  const reordered = alexState({ workouts: trained.workouts, routines: [
    { ex: alexState().routines[0].ex.map(e => Object.fromEntries(Object.entries(e).reverse())), prog: { kind: 'linear' }, emoji: '💪', name: 'Push A', id: 'r1' },
    other.routines[1]
  ] });
  assert.equal((await h.put(ALEX, reordered)).status, 200);
  assert.ok(h.read(ALEX)._rev > 9, "the sharer's revision moved three times");
  assert.equal(await h.etag(SAM), etag, 'the etag did not move');
  assert.equal((await h.incoming(SAM))[0].hash, hash, 'nor did the hash');
});

test('AC2: the sharer flipping their unit moves both the etag and the hash', async t => {
  const h = await startServer(t);
  await acceptedShare(h);
  const etag = await h.etag(SAM);
  const before = (await h.incoming(SAM))[0];
  assert.equal((await h.put(ALEX, alexState({ unit: 'kg' }))).status, 200);
  const after = (await h.incoming(SAM))[0];
  assert.equal(after.unit, 'kg');
  assert.notEqual(after.hash, before.hash);
  assert.notEqual(await h.etag(SAM), etag);
});

test('AC2: while a share waits, a weight edit leaves the recipient\'s etag alone and a rename moves it', async t => {
  const h = await startServer(t);
  await h.share(ALEX, 'r1', [SAM]);
  const etag = await h.etag(SAM);
  const pending = (await h.incoming(SAM))[0];
  const heavier = alexState();
  heavier.routines[0].ex[0].weight = 135;
  assert.equal((await h.put(ALEX, heavier)).status, 200);
  assert.equal(await h.etag(SAM), etag, 'nothing a pending recipient can see changed');
  assert.equal((await h.incoming(SAM))[0].hash, pending.hash);
  heavier.routines[0].name = 'Push heavy';
  assert.equal((await h.put(ALEX, heavier)).status, 200);
  assert.notEqual(await h.etag(SAM), etag);
  assert.equal((await h.incoming(SAM))[0].preview.name, 'Push heavy');
});

test('AC1: a routine or slot field that is not on the list stays on the server', async t => {
  const alex = alexState();
  alex.routines[0].owner = 'Alex Private';
  alex.routines[0].ex = [
    { id: '0001', sets: 3, reps: 8, weight: 60, note: 'Pause at the bottom', sg: 'a', sgName: 'Pair', sgRest: 90, warmupSets: 2,
      intensifier: { kind: 'drop', drops: 1 }, restSec: 120, photo: 'f00d', painLog: 'left knee', _x: 1 },
    { id: '0003', sets: 2, sg: 'a', sgName: 'Pair', sgRest: 90, mode: 'time', sec: 30, side: true, sideRestSec: 10 }
  ];
  const h = await startServer(t, { alex });
  await acceptedShare(h);
  const { routine } = (await h.incoming(SAM))[0];
  assert.equal('owner' in routine, false);
  assert.deepEqual(routine.ex, [
    { id: '0001', sets: 3, reps: 8, weight: 60, note: 'Pause at the bottom', sg: 'a', sgName: 'Pair', sgRest: 90, warmupSets: 2,
      intensifier: { kind: 'drop', drops: 1 }, restSec: 120 },
    { id: '0003', sets: 2, sg: 'a', sgName: 'Pair', sgRest: 90, mode: 'time', sec: 30, side: true, sideRestSec: 10 }
  ], 'the listed fields travel as stored; photo, painLog and _x do not');
});

test('AC2: the revision poll never writes db.json, even when a share\'s routine is gone; GET /api/shares cleans up', async t => {
  const h = await startServer(t, { env: { AUDIT_IP: 'full' } });   // so a missing address means something
  const id = await acceptedShare(h);
  await h.share(ALEX, 'r2', [SAM]);
  const before = await h.etag(SAM);
  // The routine goes outside PUT /api/data (a hand edit, a restored file), so nothing cleaned up.
  h.write(ALEX, alexState({ routines: alexState().routines.slice(1), _rev: 9 }));
  await tick();
  const dbBefore = h.dbBytes();
  const auditBefore = h.audit().length;
  const polled = [];
  for (let i = 0; i < 3; i++) polled.push(await h.etag(SAM));
  assert.equal(h.dbBytes(), dbBefore, 'the poll wrote nothing');
  assert.equal(h.audit().length, auditBefore);
  assert.ok(h.db().shares.some(s => s.id === id), 'the record is still there after the polls');
  assert.notEqual(polled[0], before, 'but the gone share is already out of the etag');
  assert.ok(polled.every(e => e === polled[0]));

  const list = (await h.get('/api/shares', SAM)).body;
  assert.equal(list.etag, polled[0], 'GET /api/shares answers the etag the poll announced');
  assert.deepEqual(list.incoming.map(i => i.preview?.name), ['Pull A']);
  assert.equal(h.db().shares.some(s => s.id === id), false, 'GET /api/shares deleted the record');
  const line = h.audit().find(a => a.ev === 'share.revoke' && a.msg === id);
  assert.deepEqual([line.uid, line.tgt, line.act], [ALEX, SAM, 'routine-gone'], 'audited as a revoke in the sharer\'s name');
  assert.equal('ip' in line, false, "the server's own line carries no address: it would be the recipient's");
  assert.ok(h.audit().find(a => a.ev === 'share.accept').ip, 'a line a request makes still does');
});

/* ---------- AC3: no recipient writes a shared routine ---------- */

test('AC3: PUT /api/data drops the shared-routine keys a client sends, and an own routine posing as a shared one', async t => {
  const h = await startServer(t);
  const id = await acceptedShare(h);
  const ptr = `shared:${id}`;
  const smuggled = {
    unit: 'kg',
    routines: [{ id: 's1', name: 'Legs', ex: [] }, { id: ptr, name: 'Push A (mine now)', ex: [{ id: '0001', sets: 9 }] }],
    week: { 1: [ptr, 's1'] }, dayPlan: { '2026-09-09': ptr },
    shared: { [id]: { name: 'copy' } }, sharedRoutines: [{ id: ptr }], shares: { incoming: [] }
  };
  const put = await h.put(SAM, smuggled);
  assert.equal(put.status, 200);
  const stored = h.read(SAM);
  for (const k of ['shared', 'sharedRoutines', 'shares']) assert.equal(k in stored, false, `${k} is not stored`);
  assert.deepEqual(stored.routines.map(r => r.id), ['s1'], 'no own routine under a shared id');
  assert.deepEqual(stored.week[1], [ptr, 's1'], 'the pointers are the recipient\'s to keep');
  assert.equal(stored.dayPlan['2026-09-09'], ptr);
  // So the copy could not be shared on either: the id is not one of Sam's routines.
  assert.equal((await h.share(SAM, ptr, [KIM])).body.code, 'routine-missing');

  // A key already on disk (written before this change) is not put back by the merge.
  h.write(SAM, { ...h.read(SAM), shared: { old: true } });
  await tick();
  const rev = (await h.get('/api/data/rev', SAM)).body;
  const next = await h.call('PUT', '/api/data', SAM, { state: { unit: 'kg', routines: [{ id: 's1', name: 'Legs', ex: [] }] }, baseRev: rev.rev, baseWid: rev.wid });
  assert.equal(next.status, 200);
  assert.equal('shared' in h.read(SAM), false);
});

test('AC3: nothing a recipient sends reaches the sharer\'s routine', async t => {
  const h = await startServer(t);
  const alexBefore = fs.readFileSync(path.join(h.dataDir, `state-${ALEX}.json`), 'utf8');
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const body = { routine: { id: 'r1', name: 'Hacked', ex: [] }, routineId: 'r1', state: { routines: [] } };
  assert.equal((await h.post(`/api/shares/${s.id}/accept`, SAM, body)).status, 200);
  await h.put(SAM, { unit: 'kg', routines: [{ id: 'r1', name: 'Hacked', ex: [] }] });
  assert.equal((await h.del(`/api/shares/${s.id}`, SAM)).status, 200);
  assert.equal(fs.readFileSync(path.join(h.dataDir, `state-${ALEX}.json`), 'utf8'), alexBefore);
  // No share route takes a routine body: each one is a path and an id, or POST /api/shares's
  // { routineId, to }, which reads the routine from the caller's own document.
  const src = fs.readFileSync(path.join(API, 'server.js'), 'utf8');
  const shareRoutes = [...src.matchAll(/^\s*'(GET|POST|PUT|DELETE) (\/api\/shares[^']*)':/gm)].map(m => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(shareRoutes, ['DELETE /api/shares/{id}', 'GET /api/shares', 'GET /api/shares/recipients', 'POST /api/shares', 'POST /api/shares/{id}/accept', 'POST /api/shares/{id}/decline']);
});

/* ---------- AC4: revoked, deleted, unreadable ---------- */

test('AC4: a revoked share is not projected', async t => {
  const h = await startServer(t);
  const id = await acceptedShare(h);
  assert.equal((await h.incoming(SAM)).length, 1);
  await h.del(`/api/shares/${id}`, ALEX);
  assert.deepEqual(await h.incoming(SAM), []);
});

test('AC4: the sharer\'s PUT /api/data drops their shares of a routine they deleted, in any state, and only those', async t => {
  const h = await startServer(t);
  const accepted = await acceptedShare(h);
  const [pending] = (await h.share(ALEX, 'r1', [KIM])).body.shares;
  const [declined] = (await h.share(ALEX, 'r2', [KIM])).body.shares;
  await h.post(`/api/shares/${declined.id}/decline`, KIM);
  const [keep] = (await h.share(ALEX, 'r2', [SAM])).body.shares;
  const alexEtag = await h.etag(ALEX);

  const without = alexState({ routines: [alexState().routines[1]] });   // r1 deleted
  assert.equal((await h.put(ALEX, without)).status, 200);
  assert.deepEqual(h.db().shares.map(s => s.id).sort(), [declined.id, keep.id].sort());
  for (const id of [accepted, pending.id]) {
    const line = h.audit().find(a => a.ev === 'share.revoke' && a.msg === id);
    assert.deepEqual([line.uid, line.act], [ALEX, 'routine-gone']);
  }
  assert.deepEqual((await h.incoming(SAM)).map(i => i.id), [keep.id]);
  assert.deepEqual(await h.incoming(KIM), []);
  assert.notEqual(await h.etag(ALEX), alexEtag, "the sharer's own list moved");

  // Deleting r2 too, through an empty routines list, takes the declined record as well.
  await h.put(ALEX, alexState({ routines: [] }));
  assert.deepEqual(h.db().shares, []);
});

test('AC4: a recipient\'s PUT /api/data never touches the shares addressed to them', async t => {
  const h = await startServer(t);
  const id = await acceptedShare(h);
  const before = h.dbBytes();
  // Sam has no routine called r1, and that is not a reason to drop a share Sam receives.
  assert.equal((await h.put(SAM, { unit: 'kg', routines: [], week: { 1: [`shared:${id}`] } })).status, 200);
  assert.equal(h.dbBytes(), before);
  assert.equal((await h.incoming(SAM))[0].id, id);
});

test('AC4: an unreadable sharer document hides the share as unreadable and keeps it; it heals when the file reads again', async t => {
  const h = await startServer(t);
  const id = await acceptedShare(h);
  const good = fs.readFileSync(path.join(h.dataDir, `state-${ALEX}.json`), 'utf8');
  h.write(ALEX, '{ not json');
  await tick();
  const before = h.dbBytes();
  const [item] = await h.incoming(SAM);
  assert.deepEqual(Object.keys(item).sort(), ['acceptedAt', 'created', 'from', 'id', 'state', 'unavailable']);
  assert.equal(item.unavailable, 'unreadable');
  assert.equal(h.dbBytes(), before, 'a disk problem is not a revoke: nothing deleted');
  assert.equal((await h.get('/api/nudge-check?date=2026-09-07', SAM)).status, 200);
  h.write(ALEX, good);
  await tick();
  const [healed] = await h.incoming(SAM);
  assert.equal(healed.id, id);
  assert.equal(healed.routine.name, 'Push A');
  await h.settled();
  assert.equal(h.log.match(/sharer state unreadable/g)?.length, 1, 'logged once, not once per read');
  assert.equal(await h.stackFrames(), 0, h.log);
});

/* ---------- AC5: a routine that gained a custom exercise ---------- */

test('AC5: a shared routine that gains a custom exercise is unavailable with no body; record and acceptance kept; it heals', async t => {
  const h = await startServer(t);
  const id = await acceptedShare(h);
  const acceptedAt = h.db().shares[0].acceptedAt;
  const okEtag = await h.etag(SAM);

  // An older app adds Alex's custom exercise to the shared routine; the server does not refuse it.
  const withCustom = alexState();
  withCustom.routines[0].ex.push({ id: 'c_mine', sets: 3 });
  assert.equal((await h.put(ALEX, withCustom)).status, 200);
  const hiddenEtag = await h.etag(SAM);
  assert.notEqual(hiddenEtag, okEtag, 'the recipient notices on the next poll');
  const [hidden] = await h.incoming(SAM);
  assert.deepEqual(hidden, { id, state: 'accepted', from: { id: ALEX, name: 'Alex' }, created: hidden.created, acceptedAt, unavailable: 'custom-exercise' });
  assert.deepEqual(h.db().shares.map(s => [s.id, s.state, s.acceptedAt]), [[id, 'accepted', acceptedAt]], 'kept as it was');
  assert.equal(JSON.stringify(await h.get('/api/shares', SAM)).includes('c_mine'), false);

  // The sharer takes it out again: the share is back on the next read, nothing to re-accept.
  assert.equal((await h.put(ALEX, alexState())).status, 200);
  const [back] = await h.incoming(SAM);
  assert.equal(back.routine.name, 'Push A');
  assert.equal(back.acceptedAt, acceptedAt);
  assert.notEqual(await h.etag(SAM), hiddenEtag);
});

test('AC5: a pending share of such a routine still shows its preview; accepting it gives the unavailable item', async t => {
  const h = await startServer(t);
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const withCustom = alexState();
  withCustom.routines[0].ex.push({ id: 'c_mine', sets: 3 });
  await h.put(ALEX, withCustom);
  assert.deepEqual((await h.incoming(SAM))[0].preview, { name: 'Push A', exercises: 3 });
  const acc = await h.accept(s.id, SAM);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.share.unavailable, 'custom-exercise');
  assert.equal('routine' in acc.body.share, false);
});

test('AC4: accepting a share whose routine went while it waited answers share-missing and cleans it up', async t => {
  const h = await startServer(t);
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  h.write(ALEX, alexState({ routines: [alexState().routines[1]], _rev: 9 }));   // outside PUT
  await tick();
  const r = await h.accept(s.id, SAM);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'share-missing');
  assert.deepEqual(h.db().shares, []);
  assert.equal(h.audit().find(a => a.ev === 'share.revoke' && a.msg === s.id)?.act, 'routine-gone');
});

/* ---------- AC6: a shared-only day is a training day ---------- */

// Every weekday holds only the shared routine; trained yesterday, so today is a missed day.
const dateIn = (tz, ms = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const onlyShared = (ptr, reminder) => ({
  unit: 'kg', _rev: 2, routines: [],
  week: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [ptr]])),
  workouts: [{ id: 'w0', d: dateIn(reminder?.tz || 'UTC', Date.now() - 86400000), routineId: ptr }],
  reminder
});
const wait = ms => new Promise(r => setTimeout(r, ms));
// An Etc/GMT zone whose local hour is `hour` right now (POSIX sign: Etc/GMT-5 is UTC+5).
function zoneAt(hour) {
  let off = (hour - new Date().getUTCHours() + 48) % 24;
  if (off > 14) off -= 24;
  return off === 0 ? 'UTC' : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}
const subFor = uid => ({ userId: uid, endpoint: 'https://localhost/x', keys: { p256dh: 'p', auth: 'a' }, created: new Date().toISOString() });

test('AC6: GET /api/nudge-check counts a shared-only day as planned once the share is accepted and usable', async t => {
  const h = await startServer(t);
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const ptr = `shared:${s.id}`;
  await h.put(SAM, onlyShared(ptr, { on: true, nudge: true, time: '08:00' }));
  const today = dateIn('UTC');
  const check = async () => (await h.get(`/api/nudge-check?date=${today}`, SAM)).body.nudge;
  assert.equal(await check(), false, 'pending: not a routine Sam can train yet');
  await h.accept(s.id, SAM);
  assert.equal(await check(), true, 'accepted: a missed planned day');
  const withCustom = alexState(); withCustom.routines[0].ex.push({ id: 'c_mine', sets: 3 });
  await h.put(ALEX, withCustom);
  assert.equal(await check(), false, 'unavailable: treated as absent');
  await h.put(ALEX, alexState());
  assert.equal(await check(), true);
  await h.del(`/api/shares/${s.id}`, SAM);
  assert.equal(await check(), false, 'removed');
});

test('AC6: the reminder tick reminds about a day whose only routine is a shared one', async t => {
  // A reminder due right now in UTC: the tick sends for 15 minutes after its time.
  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const shares = [{ id: '00000000000000aa', from: ALEX, to: SAM, routineId: 'r1', state: 'accepted', created: now.toISOString(), acceptedAt: now.toISOString() }];
  const ptr = 'shared:00000000000000aa';
  const h = await startServer(t, {
    shares, subs: [subFor(SAM)], env: { REMINDER_TICK_MS: '200' },
    sam: onlyShared(ptr, { on: true, time, tz: 'UTC', nudge: false })
  });
  await logLine(h.child, `reminder firing ${SAM} ${ptr}`, () => h.log);
  // The tick logs the line before it saves lastReminder, and the line can be read here before the
  // save is done. The server answers the marker request only once the tick has finished.
  await h.settled();
  assert.equal(h.db().users.find(u => u.id === SAM).lastReminder, dateIn('UTC'));
});

test('AC6: no reminder for the same day while the share is still pending', async t => {
  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const shares = [{ id: '00000000000000aa', from: ALEX, to: SAM, routineId: 'r1', state: 'pending', created: now.toISOString() }];
  const h = await startServer(t, {
    shares, subs: [subFor(SAM)], env: { REMINDER_TICK_MS: '200' },
    sam: onlyShared('shared:00000000000000aa', { on: true, time, tz: 'UTC', nudge: false })
  });
  await wait(1200);
  assert.doesNotMatch(h.log, /reminder firing/);
  // Accepting it inside the reminder's window makes the day a training day for the next tick.
  assert.equal((await h.accept('00000000000000aa', SAM)).status, 200);
  await logLine(h.child, `reminder firing ${SAM} shared:00000000000000aa`, () => h.log);
});

test('AC6: the sharer\'s PUT /api/data clears a rest day the tick settled for a recipient', async t => {
  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const shares = [{ id: '00000000000000aa', from: ALEX, to: SAM, routineId: 'r1', state: 'accepted', created: now.toISOString(), acceptedAt: now.toISOString() }];
  // The shared routine holds a custom exercise, so today reads as rest for Sam and is settled.
  const withCustom = alexState();
  withCustom.routines[0].ex.push({ id: 'c_mine', sets: 3 });
  const h = await startServer(t, {
    shares, alex: withCustom, subs: [subFor(SAM)], env: { REMINDER_TICK_MS: '200' },
    sam: onlyShared('shared:00000000000000aa', { on: true, time, tz: 'UTC', nudge: false })
  });
  await wait(1200);
  assert.doesNotMatch(h.log, /reminder firing/);
  // Alex takes the custom exercise out: Sam's file did not change, the share did.
  assert.equal((await h.put(ALEX, alexState())).status, 200);
  await logLine(h.child, `reminder firing ${SAM} shared:00000000000000aa`, () => h.log);
});

test('AC6: the missed-day nudge fires on the evening of a shared-only day', async t => {
  const tz = zoneAt(20);
  const now = new Date().toISOString();
  const shares = [{ id: '00000000000000aa', from: ALEX, to: SAM, routineId: 'r1', state: 'accepted', created: now, acceptedAt: now }];
  const ptr = 'shared:00000000000000aa';
  const h = await startServer(t, {
    shares, subs: [subFor(SAM)], env: { REMINDER_TICK_MS: '200' },
    sam: onlyShared(ptr, { on: true, time: '08:00', tz, nudge: true, tone: 'drill' })
  });
  await logLine(h.child, `nudge firing ${SAM} ${ptr}`, () => h.log);
  await h.settled();   // the save follows the line, as for the reminder above
  assert.equal(h.db().users.find(u => u.id === SAM).lastNudge, dateIn(tz));
});

/* ---------- SEC-01: a sharer's malformed routine costs one share, never the recipient's list ---------- */

// The security review's payload: valid JSON that String() throws on. Stored through the sharer's
// own PUT /api/data, which does not check a routine name's type.
const crafted = () => alexState({ routines: [{ id: 'r1', name: { toString: 1 }, emoji: { toString: 1 }, ex: [] }, alexState().routines[1]] });

test('SEC-01: a pending share of a routine whose name is not text answers 200 everywhere; the healthy one beside it is projected; the recipient declines it', async t => {
  const h = await startServer(t);
  assert.equal((await h.put(ALEX, crafted())).status, 200);
  assert.deepEqual(h.read(ALEX).routines[0].name, { toString: 1 }, 'stored as sent');
  const [bad] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const [good] = (await h.share(ALEX, 'r2', [SAM])).body.shares;

  const list = await h.get('/api/shares', SAM);
  assert.equal(list.status, 200);
  const byId = Object.fromEntries(list.body.incoming.map(i => [i.id, i]));
  assert.deepEqual(byId[bad.id].preview, { name: '', exercises: 0 }, 'the name is text or nothing');
  assert.deepEqual(byId[good.id].preview, { name: 'Pull A', exercises: 1 });
  const poll = await h.get('/api/data/rev', SAM);
  assert.equal(poll.status, 200);
  assert.equal(poll.body.shares, list.body.etag);
  assert.equal((await h.get('/api/data/rev', ALEX)).status, 200, "the sharer's own poll too");

  assert.equal((await h.post(`/api/shares/${bad.id}/decline`, SAM)).status, 200);
  assert.deepEqual((await h.incoming(SAM)).map(i => i.id), [good.id]);
  assert.equal(await h.stackFrames(), 0, h.log);
});

test('SEC-01: the same routine after acceptance: the list, the poll, the nudge check and the reminder still answer; the recipient removes it', async t => {
  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const h = await startServer(t, { subs: [subFor(SAM)], env: { REMINDER_TICK_MS: '200' } });
  assert.equal((await h.put(ALEX, crafted())).status, 200);
  const [bad] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const acc = await h.accept(bad.id, SAM);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.share.routine.name, '');
  assert.equal('emoji' in acc.body.share.routine, false);
  assert.equal(typeof acc.body.share.hash, 'string');
  assert.equal((await h.get('/api/shares', SAM)).status, 200);
  assert.equal((await h.get('/api/data/rev', SAM)).status, 200);
  // Sam's day holds only this routine, and the reminder is due now: its push text reads the name.
  assert.equal((await h.put(SAM, onlyShared(`shared:${bad.id}`, { on: true, time, tz: 'UTC', nudge: true }))).status, 200);
  assert.equal((await h.get(`/api/nudge-check?date=${dateIn('UTC')}`, SAM)).status, 200);
  await logLine(h.child, `reminder firing ${SAM} shared:${bad.id}`, () => h.log);
  await h.settled();
  assert.doesNotMatch(h.log, /reminder tick/, 'the push was built without throwing');
  assert.equal((await h.del(`/api/shares/${bad.id}`, SAM)).status, 200);
  assert.deepEqual(await h.incoming(SAM), []);
  assert.equal(await h.stackFrames(), 0, h.log);
});

test('SEC-01: a share the server cannot project at all is unreadable with its id, alone; the poll still writes nothing', async t => {
  const h = await startServer(t);
  const id = await acceptedShare(h, 'r1');
  const keep = await acceptedShare(h, 'r2');
  // A hand-edited file (PUT refuses one this deep): parses, but no hash can be taken of it.
  const deep = '['.repeat(20000) + ']'.repeat(20000);
  const raw = JSON.stringify(alexState()).replace('"weight":95', `"weight":${deep}`);
  h.write(ALEX, raw);
  await tick();
  const before = h.dbBytes();
  const list = await h.get('/api/shares', SAM);
  assert.equal(list.status, 200);
  const byId = Object.fromEntries(list.body.incoming.map(i => [i.id, i]));
  assert.equal(byId[id].unavailable, 'unreadable');
  assert.equal('routine' in byId[id], false);
  assert.equal(byId[keep].routine.name, 'Pull A', 'the other share from the same document is untouched');
  const poll = await h.get('/api/data/rev', SAM);
  assert.equal(poll.status, 200);
  assert.equal(poll.body.shares, list.body.etag);
  assert.equal(h.dbBytes(), before, 'nothing written');
  assert.equal((await h.get(`/api/nudge-check?date=${dateIn('UTC')}`, SAM)).status, 200);
  assert.equal((await h.del(`/api/shares/${id}`, SAM)).status, 200, 'the recipient can still remove it');
  assert.deepEqual((await h.incoming(SAM)).map(i => i.id), [keep]);
  await h.settled();
  // Caught where the routine's verdict is worked out (NATG-494), once per version of the
  // document, so the line names the routine rather than each share of it.
  assert.equal(h.log.match(/shares: cannot project/g)?.length, 1, 'logged once');
  assert.match(h.log, /shares: cannot project routine r1 of u_alex/);
  assert.equal(await h.stackFrames(), 0, h.log);
});
/* QA contract checks: the design and ShareIncoming require primitive text: a string, or a number
   rendered as a string; anything else is empty for `name` and left out for `emoji`. */
test('QA payload: a numeric pending routine name is rendered as a string', async t => {
  const h = await startServer(t);
  const state = alexState();
  state.routines[0].name = 42;
  assert.equal((await h.put(ALEX, state)).status, 200);
  const created = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(created.status, 200);
  const list = await h.get('/api/shares', SAM);
  assert.equal(list.status, 200);
  assert.equal(list.body.incoming[0].preview.name, '42', 'a number is rendered as a string');
});

test('QA payload: a numeric accepted routine name is rendered as a string', async t => {
  const h = await startServer(t);
  const state = alexState();
  state.routines[0].name = 42;
  assert.equal((await h.put(ALEX, state)).status, 200);
  const created = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(created.status, 200);
  const accepted = await h.accept(created.body.shares[0].id, SAM);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.share.routine.name, '42', 'a number is rendered as a string');
});

test('QA payload: a numeric accepted routine emoji is rendered as a string', async t => {
  const h = await startServer(t);
  const state = alexState();
  state.routines[0].emoji = 7;
  assert.equal((await h.put(ALEX, state)).status, 200);
  const created = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(created.status, 200);
  const accepted = await h.accept(created.body.shares[0].id, SAM);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.share.routine.emoji, '7', 'a number is rendered as a string');
});

test('QA payload: preview count and accepted slots ignore non-string exercise ids', async t => {
  const h = await startServer(t);
  const state = alexState();
  state.routines[0].ex = [{ id: '0001', sets: 3 }, { id: 7 }, { id: null }, { id: {} }, null, []];
  assert.equal((await h.put(ALEX, state)).status, 200);
  const created = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(created.status, 200);
  const pending = (await h.get('/api/shares', SAM)).body.incoming[0];
  assert.deepEqual(pending.preview, { name: 'Push A', exercises: 1 });
  const accepted = await h.accept(created.body.shares[0].id, SAM);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.share.routine.ex, [{ id: '0001', sets: 3 }]);
});

test('QA payload: hashes independently match canonical SHA-256 and invalid units use kg', async t => {
  const h = await startServer(t);
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex').slice(0, 16);
  const created = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(created.status, 200);
  const pending = (await h.get('/api/shares', SAM)).body.incoming[0];
  assert.equal(pending.hash, fingerprint({ preview: pending.preview }));
  const id = created.body.shares[0].id;
  assert.equal((await h.accept(id, SAM)).status, 200);
  for (const unit of ['lb', 'kg', 'invalid', null, 7, {}]) {
    assert.equal((await h.put(ALEX, alexState({ unit }))).status, 200);
    const list = (await h.get('/api/shares', SAM)).body;
    const item = list.incoming[0];
    assert.equal(item.unit, unit === 'lb' ? 'lb' : 'kg');
    assert.equal(item.hash, fingerprint({ unit: item.unit, routine: item.routine }));
    assert.equal(list.etag, fingerprint([[[id, 'accepted', item.hash, null]], []]));
    assert.equal((await h.get('/api/data/rev', SAM)).body.shares, list.etag);
  }
});

test('QA payload: missing sharer file preserves pending records and heals after unreadable acceptance', async t => {
  const h = await startServer(t);
  const created = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(created.status, 200);
  const id = created.body.shares[0].id;
  const file = path.join(h.dataDir, `state-${ALEX}.json`);
  const good = fs.readFileSync(file);
  fs.unlinkSync(file);
  const dbPath = path.join(h.dataDir, 'db.json');
  const before = fs.statSync(dbPath);
  const bytes = fs.readFileSync(dbPath);
  const poll = await h.get('/api/data/rev', SAM);
  assert.equal(poll.status, 200);
  assert.deepEqual(fs.readFileSync(dbPath), bytes);
  const after = fs.statSync(dbPath);
  assert.deepEqual([after.ino, after.mtimeMs, after.size], [before.ino, before.mtimeMs, before.size]);
  const list = await h.get('/api/shares', SAM);
  const pending = list.body.incoming[0];
  assert.equal(list.status, 200);
  assert.equal(list.body.etag, poll.body.shares);
  assert.deepEqual(Object.keys(pending).sort(), ['created', 'from', 'id', 'state', 'unavailable']);
  assert.equal(pending.id, id);
  assert.equal(pending.unavailable, 'unreadable');
  assert.equal(h.db().shares.length, 1);
  const accepted = await h.accept(id, SAM);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.share.unavailable, 'unreadable');
  fs.writeFileSync(file, good);
  await tick();
  const healed = (await h.get('/api/shares', SAM)).body.incoming[0];
  assert.equal(healed.id, id);
  assert.equal(healed.routine.name, 'Push A');
  assert.equal(healed.state, 'accepted');
});
