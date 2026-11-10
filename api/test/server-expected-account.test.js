/* X-Expected-Account (NATG-558): a browser tab names the account a sync request is for, and the
   server refuses a session that is not that account with a 412, before the handler runs. Every
   tab shares the session cookie, and another tab can switch it between this tab's own check and
   the request leaving. No header, no change; no session, the handler's own 401.

   Two profiles with documents of their own, so a read of the wrong one would be visible. Real
   server.js in a child, one per test, the same harness as server-nudge-check.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, stderrSettled, sampleState } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const A = 'u_a', B = 'u_b';
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const cookie = uid => ({ Cookie: `gymsid=${mint(uid)}` });
const bearer = uid => ({ Authorization: `Bearer ${mint(uid)}` });
const expect = uid => ({ 'X-Expected-Account': uid });
const REFUSED = { error: 'session is for another account', code: 'account-mismatch' };

const docOf = uid => sampleState({
  _rev: uid === A ? 3 : 8,
  workouts: [{ id: 'w-' + uid, d: '2026-09-14', name: 'Session of ' + uid, start: 1, entries: [] }]
});

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-expect-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  // Sharing on, so GET /api/shares runs its real handler (the lazy cleanup that may write).
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: A, name: 'Ana', created: now }, { id: B, name: 'Bea', created: now }],
    creds: [], subs: [], invites: [], settings: { routineSharing: { enabledAt: now, by: A } }
  }));
  for (const uid of [A, B]) fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify(docOf(uid)));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' }
  });
  const h = { log: '', dataDir, child };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.stateFile = uid => path.join(dataDir, `state-${uid}.json`);
  // The account-mismatch lines, once everything the server wrote to stderr is in.
  h.mismatchLines = async () => {
    await stderrSettled(child, h.api, () => h.log);
    return h.log.split('\n').filter(l => l.startsWith('{"ev":"account-mismatch"'));
  };
  return h;
}

// node:http rather than fetch: the keep-alive case below needs to see the socket, and every
// request here is sent the same way.
function send(h, method, p, headers = {}, body, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method, path: p, headers, agent }, res => {
      // Taken now: a keep-alive socket is detached from the response once the agent frees it.
      const socket = res.socket;
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = undefined; }
        resolve({ status: res.statusCode, body: json, socket });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const putBody = (rev, uid) => JSON.stringify({ state: { ...docOf(uid), _rev: undefined }, baseRev: rev });
// The five routes. A PUT carries a write over the session's own current revision, so it is the
// same ordinary push whichever account the session is.
const ROUTES = [
  { key: 'GET /api/data', method: 'GET', path: '/api/data' },
  { key: 'GET /api/data/rev', method: 'GET', path: '/api/data/rev' },
  { key: 'GET /api/nudge-check', method: 'GET', path: '/api/nudge-check?date=2026-09-14' },
  { key: 'GET /api/shares', method: 'GET', path: '/api/shares' },
  { key: 'PUT /api/data', method: 'PUT', path: '/api/data' }
];
async function call(h, r, uid, headers) {
  if (r.method === 'GET') return send(h, 'GET', r.path, headers);
  const rev = uid ? (await send(h, 'GET', '/api/data/rev', cookie(uid))).body.rev : 0;
  return send(h, 'PUT', r.path, { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, putBody(rev, uid || A));
}
// What a response says, without the parts that differ between two identical requests: the
// write id and revision a PUT moves on.
const answer = (r, method) => ({ status: r.status, body: method === 'PUT' ? Object.keys(r.body || {}).sort() : r.body });

for (const r of ROUTES) {
  test(`${r.key}: a session that is not the expected account gets 412, nothing else changes`, async t => {
    const h = await startServer(t);
    // No header: today's answer, for the session's own account.
    const plain = await call(h, r, B, cookie(B));
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    if (r.key === 'GET /api/data') assert.equal(plain.body.state.workouts[0].id, 'w-' + B);
    // The header naming the session's own account: the same answer.
    const same = await call(h, r, B, { ...cookie(B), ...expect(B) });
    assert.deepEqual(answer(same, r.method), answer(plain, r.method));
    // The header naming another account: refused, with nothing of either profile in the body.
    const wrong = await call(h, r, B, { ...cookie(B), ...expect(A) });
    assert.equal(wrong.status, 412);
    assert.deepEqual(wrong.body, REFUSED);
    // No session: today's 401, header or not, whichever account it names.
    const none = await call(h, r, null, {});
    assert.equal(none.status, 401);
    for (const uid of [A, B]) assert.deepEqual(answer(await call(h, r, null, expect(uid)), r.method), answer(none, r.method));
    // One line per 412, for this route.
    assert.deepEqual((await h.mismatchLines()).map(l => JSON.parse(l).route), [r.key]);
  });
}

test('a refused PUT reads no body and writes nothing; a refused GET /api/data notes no pull', async t => {
  const h = await startServer(t);
  const before = fs.readFileSync(h.stateFile(B));
  const mtime = fs.statSync(h.stateFile(B)).mtimeMs;
  const revBefore = (await send(h, 'GET', '/api/data/rev', cookie(B))).body;
  // `{}` is a 400 (state required) once the handler reads it: a 412 means it never did.
  const put = await send(h, 'PUT', '/api/data', { Origin: ORIGIN, 'Content-Type': 'application/json', ...cookie(B), ...expect(A) }, '{}');
  assert.equal(put.status, 412);
  assert.deepEqual(put.body, REFUSED);
  // A real push of A's document over B's session, the race this exists for: refused too.
  const push = await send(h, 'PUT', '/api/data', { Origin: ORIGIN, 'Content-Type': 'application/json', ...cookie(B), ...expect(A) }, putBody(revBefore.rev, A));
  assert.equal(push.status, 412);
  assert.ok(fs.readFileSync(h.stateFile(B)).equals(before), 'B’s document is byte for byte what it was');
  assert.equal(fs.statSync(h.stateFile(B)).mtimeMs, mtime);
  assert.deepEqual((await send(h, 'GET', '/api/data/rev', cookie(B))).body, revBefore);

  const get = await send(h, 'GET', '/api/data', { ...cookie(B), ...expect(A) });
  assert.equal(get.status, 412);
  assert.equal(h.db().users.find(u => u.id === B).lastPull, undefined, 'notePull never ran');
  // And the same read, accepted, does note it: the assertion above can fail.
  assert.equal((await send(h, 'GET', '/api/data', { ...cookie(B), ...expect(B) })).status, 200);
  assert.ok(h.db().users.find(u => u.id === B).lastPull > 0);
});

test('a 6 MB PUT refused before its body is read leaves the keep-alive connection usable', async t => {
  const h = await startServer(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  // Over the 5 MB body cap: had the handler read it, the answer would be a 413.
  const big = JSON.stringify({ state: { blob: 'x'.repeat(6 * 1024 * 1024) }, baseRev: 0 });
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', ...cookie(B), ...expect(A) };
  let socket;
  for (let i = 0; i < 3; i++) {
    const refused = await send(h, 'PUT', '/api/data', headers, big, agent);
    assert.equal(refused.status, 412, `round ${i}`);
    assert.deepEqual(refused.body, REFUSED);
    const next = await send(h, 'GET', '/api/data/rev', cookie(B), undefined, agent);
    assert.equal(next.status, 200, `round ${i}`);
    assert.equal(next.body.rev, 8);
    socket ??= refused.socket;
    assert.equal(refused.socket, socket, `round ${i}: the refused PUT went out on the first connection`);
    assert.equal(next.socket, socket, `round ${i}: the next request reused it`);
  }
});

test('the transport does not matter: a bearer is held to the header the same way', async t => {
  const h = await startServer(t);
  const own = await send(h, 'GET', '/api/data', { ...bearer(A), ...expect(A) });
  assert.equal(own.status, 200);
  assert.equal(own.body.state.workouts[0].id, 'w-' + A);
  // No header: a paired phone today.
  assert.equal((await send(h, 'GET', '/api/data', bearer(B))).status, 200);
  const put = await send(h, 'PUT', '/api/data', { 'Content-Type': 'application/json', ...bearer(B) }, putBody(8, B));
  assert.equal(put.status, 200);
  const wrong = await send(h, 'GET', '/api/data', { ...bearer(B), ...expect(A) });
  assert.equal(wrong.status, 412);
  assert.deepEqual(wrong.body, REFUSED);
  const lines = await h.mismatchLines();
  assert.deepEqual(lines.map(l => JSON.parse(l)), [{ ev: 'account-mismatch', route: 'GET /api/data', transport: 'bearer' }]);
});

test('the log line names the route and the transport, and nothing of either account', async t => {
  const h = await startServer(t);
  const r = await send(h, 'PUT', '/api/data', { Origin: ORIGIN, 'Content-Type': 'application/json', ...cookie(B), ...expect(A) }, putBody(8, A));
  assert.equal(r.status, 412);
  const lines = await h.mismatchLines();
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ev: 'account-mismatch', route: 'PUT /api/data', transport: 'cookie' });
  for (const word of [A, B, 'state', 'Ana', 'Bea']) assert.ok(!lines[0].includes(word), `${word} in ${lines[0]}`);
});

test('an empty or repeated header is not the account, and routes outside the five ignore it', async t => {
  const h = await startServer(t);
  assert.equal((await send(h, 'GET', '/api/data/rev', { ...cookie(B), 'X-Expected-Account': '' })).status, 412);
  // node joins a repeated header with ", ".
  assert.equal((await send(h, 'GET', '/api/data/rev', { ...cookie(B), 'X-Expected-Account': [B, B] })).status, 412);
  const me = await send(h, 'GET', '/api/me', { ...cookie(B), ...expect(A) });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, B);
});
