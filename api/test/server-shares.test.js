/* Routine sharing, slice one (NATG-484): the share records and their lifecycle. The admin option,
   the recipient list, creation with every refusal the design lists, accept, decline, revoke and
   remove, the two lists in GET /api/shares (no routine bodies yet, that is the projection), the
   caps and the audit lines, and the account-deletion cascade. Real server.js in a child, same
   harness as server-admin-delete.test.js. Each test names the acceptance criterion it covers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ORIGIN = 'http://localhost:8080';
const ADMIN = 'u_adm', ALEX = 'u_alex', SAM = 'u_sam', KIM = 'u_kim', OFF = 'u_off';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: ORIGIN });

// Alex shares; Sam and Kim receive; Off is disabled. r1 is plain, rc holds Alex's custom exercise.
const alexState = (over = {}) => ({
  unit: 'kg', _rev: 7,
  routines: [
    { id: 'r1', name: 'Push A', emoji: '💪', ex: [{ id: '0001', sets: 3, reps: 10, weight: 40 }] },
    { id: 'rc', name: 'With custom', ex: [{ id: '0001', sets: 3 }, { id: 'c_mine', sets: 3 }] }
  ],
  customEx: [{ id: 'c_mine', name: 'My move' }],
  ...over
});

async function startServer(t, { sharing = true, shares = [], alex = alexState() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-shares-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ADMIN, name: 'Adminna', created: now, admin: true },
      { id: ALEX, name: 'Alex', created: now },
      { id: SAM, name: 'Sam', created: now },
      { id: KIM, name: 'Kim', created: now },
      { id: OFF, name: 'Offline', created: now, disabled: true }
    ],
    creds: [], subs: [], invites: [], shares,
    ...(sharing ? { settings: { routineSharing: { enabledAt: now, by: ADMIN } } } : {})
  }));
  fs.writeFileSync(path.join(dataDir, `state-${ALEX}.json`), JSON.stringify(alex));
  fs.writeFileSync(path.join(dataDir, `state-${SAM}.json`), JSON.stringify({ unit: 'lb', _rev: 2, routines: [{ id: 's1', name: 'Legs', ex: [] }] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1' }
  });
  const h = { log: '', dataDir };
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
  // The status and the body exactly as sent, for "the sharer sees the same bytes" (NATG-489).
  h.raw = async (method, route, uid, body) => {
    const r = await fetch(`${h.api}${route}`, { method, headers: as(uid), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return `${r.status} ${await r.text()}`;
  };
  h.sharerView = async (uid, routineId, to) => ({
    post: await h.raw('POST', '/api/shares', uid, { routineId, to }),
    get: await h.raw('GET', '/api/shares', uid)
  });
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.audit = () => {
    try { return fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
  };
  h.stateBytes = uid => fs.readFileSync(path.join(dataDir, `state-${uid}.json`), 'utf8');
  h.stackFrames = () => h.log.split('\n').filter(l => /^\s+at /.test(l)).length;
  return h;
}

/* ---------- AC1: the admin option ---------- */

test('AC1: sharing is off by default: no config flag, and the recipient and create routes refuse', async t => {
  const h = await startServer(t, { sharing: false });
  const cfg = await h.get('/api/config', ALEX);
  assert.equal(cfg.status, 200);
  assert.equal('shares' in cfg.body, false, 'no shares key while off');
  for (const r of [await h.get('/api/shares/recipients', ALEX), await h.share(ALEX, 'r1', [SAM])]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'sharing-off');
  }
  assert.equal(h.db().shares.length, 0);
  // The list answers empty rather than refusing, so the client has one code path.
  assert.deepEqual((await h.get('/api/shares', ALEX)).body, { incoming: [], outgoing: [], etag: 'off' });
});

test('AC1: only an admin switches it on, once, and nothing switches it off', async t => {
  const h = await startServer(t, { sharing: false });
  const denied = await h.post('/api/admin/sharing/enable', ALEX);
  assert.equal(denied.status, 403);
  assert.equal((await h.get('/api/config')).body.shares, undefined);

  const on = await h.post('/api/admin/sharing/enable', ADMIN);
  assert.equal(on.status, 200);
  assert.equal(on.body.ok, true);
  assert.equal(on.body.enabled, true);
  assert.ok(!Number.isNaN(Date.parse(on.body.enabledAt)));
  assert.deepEqual(h.db().settings.routineSharing, { enabledAt: on.body.enabledAt, by: ADMIN });
  assert.equal((await h.get('/api/config')).body.shares, true, 'the flag is public, like media');

  // Idempotent: the second call keeps the first time and writes no second audit line.
  const again = await h.post('/api/admin/sharing/enable', ADMIN);
  assert.equal(again.body.enabledAt, on.body.enabledAt);
  assert.equal(h.audit().filter(a => a.ev === 'admin.sharing.enable').length, 1);
  assert.equal((await h.get('/api/shares/recipients', ALEX)).status, 200, 'the routes open');

  // No way back: the only route that touches the setting is the one that switches it on.
  const src = fs.readFileSync(path.join(API, 'server.js'), 'utf8');
  const sharingRoutes = [...src.matchAll(/^\s*'(GET|POST|PUT|DELETE) (\/api\/admin\/sharing[^']*)':/gm)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(sharingRoutes, ['POST /api/admin/sharing/enable']);
  assert.equal((await h.del('/api/admin/sharing/enable', ADMIN)).status, 404);
  assert.equal((await h.post('/api/admin/sharing/disable', ADMIN)).status, 404);
  assert.equal((await h.get('/api/config')).body.shares, true);
});

/* ---------- AC2: recipients ---------- */

test('AC2: a non-admin lists the enabled accounts on this server, ids and names only', async t => {
  const h = await startServer(t);
  const r = await h.get('/api/shares/recipients', ALEX);
  assert.equal(r.status, 200);
  // Sorted by name, without the caller and without the disabled account.
  assert.deepEqual(r.body.users, [
    { id: ADMIN, name: 'Adminna' }, { id: KIM, name: 'Kim' }, { id: SAM, name: 'Sam' }
  ]);
  assert.equal((await h.get('/api/shares/recipients')).status, 401);
});

test('AC2: nothing addresses a user on another instance', async t => {
  const h = await startServer(t);
  for (const to of ['sam@other.example', 'https://other.example/u/sam']) {
    const r = await h.share(ALEX, 'r1', [to]);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'user-missing');
  }
  assert.equal(h.db().shares.length, 0);
});

/* ---------- AC3: several recipients, independent answers, no state for the sharer ---------- */

test('AC3: several recipients make one pending record each, all or nothing', async t => {
  const h = await startServer(t);
  // One bad recipient refuses the whole request: nothing is written for the good ones.
  const partial = await h.share(ALEX, 'r1', [SAM, 'u_nobody', KIM]);
  assert.equal(partial.status, 404);
  assert.equal(partial.body.code, 'user-missing');
  assert.equal(h.db().shares.length, 0, 'all or nothing');

  const r = await h.share(ALEX, 'r1', [SAM, KIM]);
  assert.equal(r.status, 200);
  assert.equal(r.body.shares.length, 2);
  assert.match(r.body.etag, /^[0-9a-f]{16}$/);
  for (const s of r.body.shares) {
    assert.match(s.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(Object.keys(s).sort(), ['created', 'id', 'routineId', 'to']);
  }
  assert.deepEqual(r.body.shares.map(s => s.to), [{ id: SAM, name: 'Sam' }, { id: KIM, name: 'Kim' }]);
  const rows = h.db().shares;
  assert.deepEqual(rows.map(s => [s.from, s.to, s.routineId, s.state]), [[ALEX, SAM, 'r1', 'pending'], [ALEX, KIM, 'r1', 'pending']]);

  // A retry returns the same records and writes nothing new.
  const retry = await h.share(ALEX, 'r1', [SAM, KIM]);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.shares, r.body.shares);
  assert.equal(h.db().shares.length, 2);
});

test('AC3: each recipient answers their own record, and the sharer cannot tell a decline from a pending share', async t => {
  const h = await startServer(t);
  const created = (await h.share(ALEX, 'r1', [SAM, KIM])).body.shares;
  const idFor = uid => created.find(s => s.to.id === uid).id;

  const before = await h.get('/api/shares', ALEX);
  const samIn = await h.get('/api/shares', SAM);
  assert.deepEqual(samIn.body.incoming.map(i => [i.id, i.state, i.from]), [[idFor(SAM), 'pending', { id: ALEX, name: 'Alex' }]]);
  assert.equal('routine' in samIn.body.incoming[0], false, 'no routine body in this slice');

  const acc = await h.post(`/api/shares/${idFor(SAM)}/accept`, SAM);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.share.state, 'accepted');
  assert.ok(acc.body.share.acceptedAt);
  assert.notEqual(acc.body.etag, samIn.body.etag, "the recipient's etag moves on accept");
  const dec = await h.post(`/api/shares/${idFor(KIM)}/decline`, KIM);
  assert.equal(dec.status, 200);

  assert.deepEqual(h.db().shares.map(s => [s.to, s.state]), [[SAM, 'accepted'], [KIM, 'declined']]);
  // Pending or accepted, the recipient always sees who is sharing.
  assert.deepEqual(acc.body.share.from, { id: ALEX, name: 'Alex' });
  const samAfter = (await h.get('/api/shares', SAM)).body.incoming[0];
  assert.equal(samAfter.state, 'accepted');
  assert.deepEqual(samAfter.from, { id: ALEX, name: 'Alex' });
  assert.deepEqual((await h.get('/api/shares', KIM)).body.incoming, [], 'a declined share leaves the recipient list');

  // The sharer's view is the same after the answers as before them: no state, every record.
  const after = await h.get('/api/shares', ALEX);
  assert.deepEqual(after.body, before.body);
  for (const o of after.body.outgoing) assert.deepEqual(Object.keys(o).sort(), ['created', 'id', 'routineId', 'to']);

  // Each record answers once; nobody else can answer it.
  assert.equal((await h.post(`/api/shares/${idFor(SAM)}/accept`, SAM)).body.code, 'share-state');
  assert.equal((await h.post(`/api/shares/${idFor(KIM)}/accept`, KIM)).status, 409);
  const notYours = await h.post(`/api/shares/${idFor(SAM)}/decline`, KIM);
  assert.equal(notYours.status, 404);
  assert.equal(notYours.body.code, 'share-missing');
  assert.equal((await h.post(`/api/shares/${idFor(KIM)}/accept`, ALEX)).body.code, 'share-missing', 'the sharer cannot accept for them');
  for (const bad of ['nothex', 'ABCDEF0123456789', '0123456789abcde']) {
    const r = await h.post(`/api/shares/${bad}/accept`, SAM);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'share-missing');
  }
  assert.equal(h.stackFrames(), 0, `no stack traces:\n${h.log}`);
});

test('AC3: sharing again changes nothing whatever the recipient did; to offer it again the sharer revokes and shares', async t => {
  const h = await startServer(t);
  const [first] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  await h.post(`/api/shares/${first.id}/decline`, SAM);
  const before = h.db().shares;
  const again = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.shares, [first], 'same id, same created');
  assert.deepEqual(h.db().shares, before, 'no reopen: the declined record is left as it is');
  assert.deepEqual((await h.get('/api/shares', SAM)).body.incoming, [], 'the recipient is not asked again');
  assert.equal(h.audit().filter(a => a.ev === 'share.create').length, 1);

  // Revoke and share again: a new record with a new id, pending for the recipient.
  await h.del(`/api/shares/${first.id}`, ALEX);
  const fresh = await h.share(ALEX, 'r1', [SAM]);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.shares[0].id, first.id);
  assert.deepEqual((await h.get('/api/shares', SAM)).body.incoming.map(i => [i.id, i.state]), [[fresh.body.shares[0].id, 'pending']]);
});

// NATG-489: the Tester's repro. Two recipients; one declines, the other removes after accepting.
// The sharer repeats the identical create and reads the list, and gets the same bytes as when
// both were still pending.
test('AC3: an identical re-share after a decline or a removal answers the sharer byte for byte as when pending', async t => {
  const h = await startServer(t);
  const created = (await h.share(ALEX, 'r1', [SAM, KIM])).body.shares;
  const idFor = uid => created.find(s => s.to.id === uid).id;
  const one = uid => h.raw('POST', '/api/shares', ALEX, { routineId: 'r1', to: [uid] });
  const pending = await h.sharerView(ALEX, 'r1', [SAM, KIM]);
  const pendingOne = { [SAM]: await one(SAM), [KIM]: await one(KIM) };
  assert.match(pending.post, /^200 /);

  await h.post(`/api/shares/${idFor(SAM)}/decline`, SAM);
  await h.post(`/api/shares/${idFor(KIM)}/accept`, KIM);
  await h.del(`/api/shares/${idFor(KIM)}`, KIM);
  assert.deepEqual(h.db().shares.map(s => s.state), ['declined', 'removed']);

  const answered = await h.sharerView(ALEX, 'r1', [SAM, KIM]);
  assert.equal(answered.post, pending.post);
  assert.equal(answered.get, pending.get);
  // One recipient at a time too, which is the narrower form of the repro.
  for (const uid of [SAM, KIM]) assert.equal(await one(uid), pendingOne[uid], uid);
  assert.deepEqual(h.db().shares.map(s => s.state), ['declined', 'removed'], 'still not reopened');
});

test('AC3: the request shape is checked before anything else', async t => {
  const h = await startServer(t);
  for (const body of [
    {}, { routineId: 'r1' }, { routineId: 'r1', to: [] }, { routineId: 'r1', to: 'u_sam' },
    { routineId: 'r1', to: [SAM, SAM] }, { routineId: 'r1', to: [1] }, { routineId: 5, to: [SAM] },
    { routineId: 'x'.repeat(65), to: [SAM] },
    { routineId: 'r1', to: Array.from({ length: 21 }, (_, i) => `u_${i}`) }
  ]) {
    const r = await h.post('/api/shares', ALEX, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'bad-request', JSON.stringify(body));
  }
  assert.equal(h.db().shares.length, 0);
});

/* ---------- AC4 and AC5: what creation refuses ---------- */

test('AC4: a routine that is not in the caller\'s own document is refused, so a shared one cannot be passed on', async t => {
  const h = await startServer(t);
  const [s] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  await h.post(`/api/shares/${s.id}/accept`, SAM);
  // Sam holds the share, but neither its pointer nor Alex's routine id is in Sam's routines.
  for (const routineId of [`shared:${s.id}`, 'r1', 'nope']) {
    const r = await h.share(SAM, routineId, [KIM]);
    assert.equal(r.status, 404, routineId);
    assert.equal(r.body.code, 'routine-missing', routineId);
  }
  assert.equal(h.db().shares.length, 1);
  // A profile with no document at all has no routines either.
  assert.equal((await h.share(KIM, 'r1', [SAM])).body.code, 'routine-missing');
});

test('AC4: sharing with yourself, an unknown user or a disabled one is refused', async t => {
  const h = await startServer(t);
  const self = await h.share(ALEX, 'r1', [SAM, ALEX]);
  assert.equal(self.status, 400);
  assert.equal(self.body.code, 'self');
  for (const to of [['u_nobody'], [OFF]]) {
    const r = await h.share(ALEX, 'r1', to);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'user-missing');
  }
  assert.equal(h.db().shares.length, 0);
});

test('AC5: a routine with a custom exercise is refused', async t => {
  const h = await startServer(t);
  const r = await h.share(ALEX, 'rc', [SAM]);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'custom-exercise');
  assert.equal(h.db().shares.length, 0);
});

/* ---------- AC6: revoke, remove, decline, and deleted accounts ---------- */

test('AC6: the sharer revokes in any state, and the routine is untouched', async t => {
  const h = await startServer(t);
  const shares = (await h.share(ALEX, 'r1', [SAM, KIM, ADMIN])).body.shares;
  const [toSam, toKim, toAdmin] = shares.map(s => s.id);
  await h.post(`/api/shares/${toSam}/accept`, SAM);
  await h.post(`/api/shares/${toKim}/decline`, KIM);
  const routineBefore = h.stateBytes(ALEX);
  for (const id of [toSam, toKim, toAdmin]) {   // accepted, declined, pending
    const r = await h.del(`/api/shares/${id}`, ALEX);
    assert.equal(r.status, 200, id);
    assert.equal(r.body.ok, true);
  }
  assert.equal(h.db().shares.length, 0, 'revoking deletes the record');
  assert.deepEqual((await h.get('/api/shares', SAM)).body.incoming, []);
  assert.equal(h.stateBytes(ALEX), routineBefore, "the sharer's document is not written");
  assert.equal((await h.del(`/api/shares/${toSam}`, ALEX)).body.code, 'share-missing', 'a second revoke finds nothing');
});

test('AC6: the recipient removes an accepted share and declines a pending one; the sharer still sees both', async t => {
  const h = await startServer(t);
  const routineBefore = h.stateBytes(ALEX);
  const [a] = (await h.share(ALEX, 'r1', [SAM])).body.shares;
  const [p] = (await h.share(ALEX, 'r1', [KIM])).body.shares;
  await h.post(`/api/shares/${a.id}/accept`, SAM);
  const outgoingBefore = (await h.get('/api/shares', ALEX)).body;

  assert.equal((await h.del(`/api/shares/${a.id}`, SAM)).status, 200);
  assert.equal((await h.del(`/api/shares/${p.id}`, KIM)).status, 200);
  assert.deepEqual(h.db().shares.map(s => [s.id, s.state]), [[a.id, 'removed'], [p.id, 'declined']]);
  assert.deepEqual((await h.get('/api/shares', SAM)).body.incoming, []);
  assert.deepEqual((await h.get('/api/shares', ALEX)).body, outgoingBefore, 'a removal is invisible to the sharer');
  assert.equal(h.stateBytes(ALEX), routineBefore, "the sharer's routine is untouched");

  // A retry of the removal changes nothing and is not an error.
  assert.equal((await h.del(`/api/shares/${a.id}`, SAM)).status, 200);
  assert.equal(h.db().shares.find(s => s.id === a.id).state, 'removed');
  // A third profile cannot touch it.
  const other = await h.del(`/api/shares/${a.id}`, ADMIN);
  assert.equal(other.status, 404);
  assert.equal(other.body.code, 'share-missing');
});

test('AC6: deleting an account, through the admin delete or its own, removes its shares in both directions', async t => {
  const h = await startServer(t);
  await h.share(ALEX, 'r1', [SAM, KIM]);
  fs.writeFileSync(path.join(h.dataDir, `state-${KIM}.json`), JSON.stringify({ routines: [{ id: 'k1', name: 'Kim A', ex: [] }] }));
  await h.share(KIM, 'k1', [SAM, ALEX]);
  await h.share(SAM, 's1', [KIM, ALEX]);
  assert.equal(h.db().shares.length, 6);

  // The admin deletes Kim: Kim's two outgoing and the two addressed to Kim go.
  assert.equal((await h.post('/api/admin/user/delete', ADMIN, { id: KIM })).status, 200);
  const left = h.db().shares;
  assert.equal(left.some(s => s.from === KIM || s.to === KIM), false);
  assert.deepEqual(left.map(s => [s.from, s.to]), [[ALEX, SAM], [SAM, ALEX]]);

  // Sam deletes their own account from a paired phone (the pairing is the proof without a password).
  const r = await fetch(`${h.api}/api/account/delete`, {
    method: 'POST', headers: { Authorization: `Bearer ${mintSession(SAM)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sam' })
  });
  assert.equal(r.status, 200);
  assert.deepEqual(h.db().shares, []);
  assert.deepEqual((await h.get('/api/shares', ALEX)).body.incoming, []);
});

/* ---------- AC7: caps, window, audit ---------- */

test('AC7: at most 50 outgoing shares per profile, declined and removed ones included; only a revoke frees one', async t => {
  const created = new Date().toISOString();
  const row = (i, state, to = SAM) => ({ id: i.toString(16).padStart(16, '0'), from: ALEX, to, routineId: `old${i}`, state, created });
  const full = Array.from({ length: 50 }, (_, i) => row(i + 1, ['pending', 'accepted', 'declined', 'removed'][i % 4]));
  const h = await startServer(t, { shares: full });
  const r = await h.share(ALEX, 'r1', [KIM]);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'share-limit');
  assert.equal(h.db().shares.length, 50);
  // One revoke makes room.
  await h.del(`/api/shares/${full[2].id}`, ALEX);
  assert.equal((await h.share(ALEX, 'r1', [KIM])).status, 200);
});

// NATG-489: at the cap, a recipient's decline must not free a place the sharer could probe for.
test('AC7: at the cap, a decline changes none of the sharer\'s answers', async t => {
  const created = new Date().toISOString();
  const old = Array.from({ length: 49 }, (_, i) => ({ id: (i + 1).toString(16).padStart(16, '0'), from: ALEX, to: SAM, routineId: `old${i}`, state: 'pending', created }));
  const h = await startServer(t, { shares: old });
  const [mine] = (await h.share(ALEX, 'r1', [SAM])).body.shares;   // the 50th
  const pending = { over: await h.sharerView(ALEX, 'r1', [KIM]), retry: await h.sharerView(ALEX, 'r1', [SAM]) };
  assert.match(pending.over.post, /^409 .*share-limit/);
  assert.match(pending.retry.post, /^200 /);

  assert.equal((await h.post(`/api/shares/${mine.id}/decline`, SAM)).status, 200);
  const declined = { over: await h.sharerView(ALEX, 'r1', [KIM]), retry: await h.sharerView(ALEX, 'r1', [SAM]) };
  assert.deepEqual(declined, pending);
  assert.equal(h.db().shares.length, 50);
});

test('AC7: 30 creating requests an hour per profile; a retry that creates nothing spends nothing', async t => {
  const routines = Array.from({ length: 32 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, ex: [] }));
  const h = await startServer(t, { alex: alexState({ routines }) });
  for (let i = 0; i < 30; i++) assert.equal((await h.share(ALEX, `w${i}`, [SAM])).status, 200, `call ${i + 1}`);
  // Asking again for what exists is free.
  assert.equal((await h.share(ALEX, 'w0', [SAM])).status, 200);
  const over = await h.share(ALEX, 'w30', [SAM]);
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'locked');
  assert.ok(over.body.retryAfter > 0 && over.body.retryAfter <= 3600);
  assert.equal(h.db().shares.length, 30);
  // Per profile: Sam's budget is their own.
  assert.equal((await h.share(SAM, 's1', [KIM])).status, 200);
});

// NATG-489: with the window spent, a retry for a recipient who has since declined is still free.
test('AC7: with the hourly budget spent, a retry after a decline answers as it did while pending', async t => {
  const routines = Array.from({ length: 31 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, ex: [] }));
  const h = await startServer(t, { alex: alexState({ routines }) });
  let first;
  for (let i = 0; i < 30; i++) {
    const r = await h.share(ALEX, `w${i}`, [SAM]);
    assert.equal(r.status, 200, `call ${i + 1}`);
    first ??= r.body.shares[0];
  }
  const over = () => h.share(ALEX, 'w30', [SAM]);
  assert.equal((await over()).status, 429, 'the budget is spent');
  const pending = await h.sharerView(ALEX, 'w0', [SAM]);
  assert.match(pending.post, /^200 /);

  await h.post(`/api/shares/${first.id}/decline`, SAM);
  assert.deepEqual(await h.sharerView(ALEX, 'w0', [SAM]), pending);
  // A request that would create a record is still refused, as before the decline. Its
  // retryAfter counts down, so the status and code are what is compared.
  const after = await over();
  assert.equal(after.status, 429);
  assert.equal(after.body.code, 'locked');
  assert.equal(h.db().shares.length, 30);
});

test('AC7: every create, accept, decline, revoke and remove writes an audit line with the share id and both user ids', async t => {
  const h = await startServer(t);
  const shares = (await h.share(ALEX, 'r1', [SAM, KIM, ADMIN])).body.shares;
  const id = uid => shares.find(s => s.to.id === uid).id;
  await h.post(`/api/shares/${id(SAM)}/accept`, SAM);
  await h.del(`/api/shares/${id(SAM)}`, SAM);          // remove
  await h.post(`/api/shares/${id(KIM)}/decline`, KIM);
  await h.del(`/api/shares/${id(ADMIN)}`, ADMIN);      // a pending one deleted by its recipient: a decline
  await h.del(`/api/shares/${id(KIM)}`, ALEX);         // revoke
  const rows = h.audit().filter(a => a.ev.startsWith('share.')).map(a => [a.ev, a.msg, a.uid, a.tgt]);
  assert.deepEqual(rows, [
    ['share.create', id(SAM), ALEX, SAM],
    ['share.create', id(KIM), ALEX, KIM],
    ['share.create', id(ADMIN), ALEX, ADMIN],
    ['share.accept', id(SAM), SAM, ALEX],
    ['share.remove', id(SAM), SAM, ALEX],
    ['share.decline', id(KIM), KIM, ALEX],
    ['share.decline', id(ADMIN), ADMIN, ALEX],
    ['share.revoke', id(KIM), ALEX, KIM]
  ]);
});
