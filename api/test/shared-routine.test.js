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
