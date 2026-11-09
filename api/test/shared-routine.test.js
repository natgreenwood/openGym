/* The size cap on a shared routine (NATG-494), on the pure side: the measure is exactly the UTF-8
   length of JSON.stringify(sharedRoutine(r)) up to the cap, its early exit gives the same verdict
   at the boundary, and the name a recipient sees is bounded the same way everywhere it leaves. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SHARED_BYTES, MAX_SHARED_NAME, sharedBytes, sharedOverCap, sharedName, sharedRoutine, sharedPreview
} from '../shared-routine.js';

const full = r => Buffer.byteLength(JSON.stringify(sharedRoutine(r)));
const routine = (slots, over = {}) => ({
  id: 'r1', name: 'Push A', emoji: '💪', prog: { kind: 'linear' }, notes: 'private', _ts: 5,
  ex: Array.from({ length: slots }, (_, i) => ({ id: String(i).padStart(4, '0'), sets: 3, reps: 10, note: 'Pausé ✓', subs: ['x'], _f: { a: 1 } })),
  ...over
});
// A one-slot routine whose projection is exactly `bytes` long, padded in the slot's note.
function sized(bytes) {
  const r = routine(1);
  r.ex[0].note = '';
  r.ex[0].note = 'a'.repeat(bytes - full(r));
  assert.equal(full(r), bytes);
  return r;
}

test('the measure is the UTF-8 length of the projection, whatever the routine holds', () => {
  const cases = [
    routine(0), routine(1), routine(40),
    routine(3, { name: undefined, emoji: { toString: 1 } }),
    routine(2, { name: 'Ünïcödé 🏋️ day', ex: [{ id: '0001', note: '日本語のメモ' }, { id: 7 }, null, 'x', { id: '0002' }] }),
    { id: 'r9' },
    { id: 'r9', ex: 'not a list', excludeFromProgression: true }
  ];
  for (const r of cases) assert.equal(sharedBytes(r), full(r), JSON.stringify(r));
});

test('the verdict at the boundary: exactly the cap is shareable, one byte more is not', () => {
  assert.equal(MAX_SHARED_BYTES, 65536);
  assert.equal(sharedOverCap(sized(MAX_SHARED_BYTES)), false);
  assert.equal(sharedOverCap(sized(MAX_SHARED_BYTES + 1)), true);
  // Multi-byte characters count as their UTF-8 bytes, not as characters.
  const r = sized(MAX_SHARED_BYTES - 1);
  r.ex[0].note = r.ex[0].note.slice(1) + 'é';
  assert.equal(full(r), MAX_SHARED_BYTES);
  assert.equal(sharedOverCap(r), false);
  r.ex[0].note = r.ex[0].note.slice(1) + 'é';
  assert.equal(full(r), MAX_SHARED_BYTES + 1);
  assert.equal(sharedOverCap(r), true);
});

test('the early exit: past the cap the count stops, over the cap, with the same verdict as the whole', () => {
  const big = routine(20000);
  assert.ok(full(big) > MAX_SHARED_BYTES * 5);
  const n = sharedBytes(big);
  assert.ok(n > MAX_SHARED_BYTES, 'over the cap');
  assert.ok(n < full(big), 'and short of serialising every slot');
  // A slot that alone passes the cap ends the count there.
  const one = routine(3);
  one.ex[0].note = 'x'.repeat(MAX_SHARED_BYTES);
  assert.equal(sharedOverCap(one), true);
  // A lower cap is honoured the same way.
  assert.equal(sharedBytes(routine(2), 10) > 10, true);
  assert.equal(sharedBytes(routine(2), 1e9), full(routine(2)));
});

test('a routine the projection cannot be taken of throws, for the caller to decide what it means', () => {
  // Parsed JSON gives no such value on every Node (a RangeError on deep nesting is the known one,
  // and newer engines serialise far deeper), so a getter stands in for it.
  const r = routine(1);
  Object.defineProperty(r.ex[0], 'note', { enumerable: true, get() { throw new RangeError('too deep'); } });
  assert.throws(() => sharedBytes(r), RangeError);
  assert.throws(() => sharedOverCap(r), RangeError);
});

test('the name is bounded at 80 characters, the same in the routine, the preview and the hash input', () => {
  assert.equal(MAX_SHARED_NAME, 80);
  assert.equal(sharedName({ name: 'Push A' }), 'Push A');
  assert.equal(sharedName({ name: 'x'.repeat(80) }), 'x'.repeat(80));
  assert.equal(sharedName({ name: 'x'.repeat(5_000_000) }), 'x'.repeat(80));
  assert.equal(sharedName({ name: 12 }), '12');
  assert.equal(sharedName({ name: { toString: 1 } }), '');
  // Characters, not UTF-16 units: a name of emoji keeps 80 whole ones and never half of one.
  const emoji = '🏋️'.repeat(100);
  const bounded = sharedName({ name: emoji });
  assert.equal(Array.from(bounded).length, 80);
  assert.ok(emoji.startsWith(bounded));
  assert.equal(sharedName({ name: 'a' + '💪'.repeat(100) }), 'a' + '💪'.repeat(79));
  const long = routine(2, { name: 'L'.repeat(500) });
  assert.equal(sharedRoutine(long).name, 'L'.repeat(80));
  assert.equal(sharedPreview(long).name, 'L'.repeat(80));
});

/* Tester's finding on PR #87: the count stopped at the cap, but the projection it counted was
   built first, over every slot. What is read of an over-cap routine has to be bounded by the cap,
   not by the number of slots, so these count the reads themselves. */

// `r` with its `ex` behind a Proxy that counts the slots read, and a getter on every slot's note
// that records which slots had it read (pick reads a field twice, so slots, not reads).
function counted(r) {
  const noted = new Set();
  const seen = { slots: 0, get notes() { return noted.size; } };
  for (const e of r.ex) {
    if (!e || typeof e !== 'object' || !('note' in e)) continue;
    const note = e.note;
    Object.defineProperty(e, 'note', { enumerable: true, get() { noted.add(e); return note; } });
  }
  r.ex = new Proxy(r.ex, { get(a, k, rx) { if (typeof k === 'string' && /^\d+$/.test(k)) seen.slots++; return Reflect.get(a, k, rx); } });
  return { r, seen };
}

test('an over-cap routine is read only as far as the cap: slots past it are never filtered, picked or serialised', () => {
  const r = routine(20000);
  const slotBytes = Buffer.byteLength(JSON.stringify(sharedRoutine(routine(1)).ex[0]));
  const fit = Math.ceil(MAX_SHARED_BYTES / slotBytes);   // slots the cap can hold, near enough
  const { r: probe, seen } = counted(r);
  assert.equal(sharedOverCap(probe), true);
  assert.ok(seen.slots <= fit + 1, `${seen.slots} slots read, the cap holds about ${fit}`);
  assert.ok(seen.notes <= fit + 1, `${seen.notes} slots' notes read, the cap holds about ${fit}`);
  // The same bound with dropped slots in among the kept ones: they cost a read each, no more.
  const mixed = routine(20000);
  mixed.ex = mixed.ex.flatMap((e, i) => [e, null, { id: i }, 'x']);
  const { r: probe2, seen: seen2 } = counted(mixed);
  assert.equal(sharedOverCap(probe2), true);
  assert.ok(seen2.slots <= 4 * (fit + 1), `${seen2.slots} slots read`);
  assert.ok(seen2.notes <= fit + 1, `${seen2.notes} slots' notes read`);
  // One slot over the cap on its own ends the walk there.
  const one = routine(20000);
  one.ex[0].note = 'x'.repeat(MAX_SHARED_BYTES);
  const { r: probe3, seen: seen3 } = counted(one);
  assert.equal(sharedOverCap(probe3), true);
  assert.equal(seen3.slots, 1);
});

test('property: the measure is exact up to the cap and over it past the cap, on random routines with every kind of slot', () => {
  // Deterministic, so a failure names a case that can be rerun.
  let seed = 494;
  const rnd = () => {   // mulberry32
    let x = (seed = (seed + 0x6d2b79f5) | 0);
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
  const pickOf = xs => xs[Math.floor(rnd() * xs.length)];
  const chars = ['a', 'é', '✓', '日', '💪', '"', '\\', '\n', ' ', ' '];
  const str = max => Array.from({ length: Math.floor(rnd() * max) }, () => pickOf(chars)).join('');
  const value = () => pickOf([() => Math.floor(rnd() * 200), () => rnd() * 100, () => str(20), () => true, () => null, () => [1, 'two', { three: 3 }], () => ({ kind: str(5) })])();
  const slot = () => pickOf([
    // Kept: an entry with a string id, listed fields, unlisted ones, an undefined one, a long note.
    () => ({ id: str(6) || '0001', sets: value(), reps: value(), weight: value(), note: str(rnd() < 0.1 ? 4000 : 40), subs: [str(4)], _f: { a: 1 }, extra: value(), restSec: undefined }),
    () => ({ id: '0002', intensifier: { type: 'dropset', count: 2 }, pyramid: [{ w: 1, r: 2 }] }),
    // Dropped: not an entry, or an id that is not a string.
    () => null, () => undefined, () => 7, () => 'slot', () => [1, 2], () => true,
    () => ({ id: 12, note: str(40) }), () => ({ note: 'no id' }), () => ({ id: null })
  ])();
  let under = 0, over = 0;
  for (let k = 0; k < 400; k++) {
    const n = Math.floor(rnd() * (rnd() < 0.2 ? 3000 : 60));
    const r = {
      id: str(8), name: pickOf([str(120), 12, { toString: 1 }, undefined]), emoji: pickOf([str(3), 3, undefined, {}]),
      prog: pickOf([{ kind: 'linear' }, 'double', undefined]), excludeFromProgression: pickOf([true, undefined]), notes: str(50),
      ex: pickOf([Array.from({ length: n }, slot), Array.from({ length: n }, slot), 'not a list', undefined])
    };
    const whole = full(r);
    assert.equal(sharedBytes(r, Infinity), whole, `case ${k}: uncapped`);
    if (whole <= MAX_SHARED_BYTES) { under++; assert.equal(sharedBytes(r), whole, `case ${k}: under the cap`); }
    else { over++; assert.ok(sharedBytes(r) > MAX_SHARED_BYTES, `case ${k}: over the cap`); }
    assert.equal(sharedOverCap(r), whole > MAX_SHARED_BYTES, `case ${k}: verdict`);
  }
  assert.ok(under > 50 && over > 10, `both sides covered (${under} under, ${over} over)`);
});
