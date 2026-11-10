/* Exact ties (sync-merge.js "Exact ties", NATG-561): two values of one field that carry the same
 * stamp. The first argument used to win, so the result depended on which copy merged into which,
 * and three copies came out different depending on which two met first. Now the value that sorts
 * higher wins, on every copy. */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mergeEntry, mergeStates, stampChange } from './sync-merge.js'

const clone = o => JSON.parse(JSON.stringify(o))
const m = (x, y) => mergeEntry(clone(x), clone(y))
const ms = (x, y) => mergeStates(clone(x), clone(y))
// Every way three copies can meet: each grouping, each order within it.
const orders3 = (A, B, C, merge) => [
  merge(merge(A, B), C), merge(A, merge(B, C)), merge(merge(B, A), C), merge(merge(C, A), B),
  merge(B, merge(C, A)), merge(C, merge(A, B)), merge(merge(A, C), B), merge(merge(C, B), A),
]

describe('a field two copies stamped at the same time', () => {
  it('comes out the same whichever two of three versions meet first', () => {
    const a = { id: 'r', name: 'X', sets: 3, _ts: 10, _f: { name: 5, sets: 10 } }
    const b = { id: 'r', name: 'Y', sets: 3, reps: 8, _ts: 20, _f: { name: 3, reps: 20 } }
    const c = { id: 'r', name: 'Z', sets: 3, _ts: 15, _f: { name: 5 } }
    const all = orders3(a, b, c, m)
    for (const x of all) expect(x).toEqual(all[0])
    // 'Z' sorts above 'X': the higher value of the two stamped 5 wins.
    expect(all[0].name).toBe('Z')
    expect(all[0]).toMatchObject({ reps: 8, _ts: 20, _f: { name: 5, sets: 10, reps: 20 } })
  })

  it('comes out the same whichever copy merges into which', () => {
    const a = { id: 'r', name: 'Push A', _ts: 7, _f: { name: 7 } }
    const c = { id: 'r', name: 'Push C', _ts: 7, _f: { name: 7 } }
    expect(m(a, c)).toEqual(m(c, a))
    expect(m(a, c).name).toBe('Push C')
  })

  it('compares objects by content, not by the order their keys were written in', () => {
    const a = { id: 'r', ex: { sets: 3, reps: 5 }, _ts: 4, _f: { ex: 4 } }
    const b = { id: 'r', ex: { reps: 5, sets: 3 }, _ts: 4, _f: { ex: 4 } }
    const c = { id: 'r', ex: { reps: 6, sets: 3 }, _ts: 4, _f: { ex: 4 } }
    expect(m(a, b).ex).toEqual({ sets: 3, reps: 5 })
    expect(m(a, c)).toEqual(m(c, a))
    expect(m(m(a, b), c)).toEqual(m(a, m(b, c)))
  })

  it('keeps a set value over a removal made at the same time, either way round', () => {
    const a = { id: 'r', note: 'hi', _ts: 4, _f: { note: 4 } }
    const b = { id: 'r', _ts: 4, _f: { note: 4 } }
    expect(m(a, b)).toEqual(m(b, a))
    expect(m(b, a).note).toBe('hi')
  })

  it('still lets an Undo win the tie it covers, and the version edited last decide an unstamped field', () => {
    const undo = { id: 'r', sets: 3, _ts: 9, _f: { sets: 9 }, _u: { sets: [2, 8, 9] } }
    const other = { id: 'r', sets: 5, _ts: 9, _f: { sets: 9 } }
    expect(m(undo, other).sets).toBe(3)
    expect(m(other, undo).sets).toBe(3)
    const older = { id: 'r', name: 'Z', _ts: 3 }, newer = { id: 'r', name: 'A', _ts: 4 }
    expect(m(older, newer).name).toBe('A')
    expect(m(newer, older).name).toBe('A')
  })
})

describe('a routine renamed on two devices at the same stamp (stampChange)', () => {
  // Every device's clock is behind the copy's highest stamp H, so each first change is stamped H+1.
  const H = 1000
  const base = { _ts: H, unit: 'kg', workouts: [], routines: [{ id: 'r', name: 'Push', sets: 3, _ts: H }], favEx: [] }
  const change = (prev, mut) => { const n = clone(prev); mut(n); n._ts = stampChange(prev, n, 1); return n }
  const A = change(change(base, S => { S.routines[0].name = 'Push A' }), S => { S.routines[0].sets = 4 })
  const C = change(base, S => { S.routines[0].name = 'Push C' })
  const B = change(change(change(base, S => { S.routines[0].reps = 8 }), S => { S.routines[0].reps = 9 }), S => { S.routines[0].reps = 10 })

  it('has both renames stamped the same', () => {
    expect(A.routines[0]._f.name).toBe(H + 1)
    expect(C.routines[0]._f.name).toBe(H + 1)
  })

  it('is the same routine whichever two of three copies meet first', () => {
    const all = orders3(A, B, C, ms).map(S => S.routines)
    for (const r of all) expect(r).toEqual(all[0])
    expect(all[0][0]).toMatchObject({ name: 'Push C', sets: 4, reps: 10 })
  })

  it('is the same routine whichever of two copies merges into the other', () => {
    expect(ms(A, C).routines).toEqual(ms(C, A).routines)
    expect(ms(A, C).routines[0].name).toBe('Push C')
  })
})

// Versions of one entry on stamps drawn from a handful of values, so most fields tie somewhere.
const FIELDS = ['name', 'sets', 'note']
const VALUES = [undefined, 'a', 'b', 3, 5, { x: 1, y: 2 }, { y: 2, x: 1 }, [1, 2]]
const version = fc.record({
  vals: fc.tuple(...FIELDS.map(() => fc.constantFrom(...VALUES.keys()))),
  stamps: fc.tuple(...FIELDS.map(() => fc.integer({ min: 0, max: 3 }))),
  extra: fc.integer({ min: 0, max: 4 }),
}).map(({ vals, stamps, extra }) => {
  const x = { id: 'e' }, f = {}
  FIELDS.forEach((k, i) => {
    if (VALUES[vals[i]] !== undefined) x[k] = clone(VALUES[vals[i]])
    if (stamps[i]) f[k] = stamps[i]
  })
  if (Object.keys(f).length) x._f = f
  const ts = Math.max(extra, ...Object.values(f))
  if (ts) x._ts = ts
  return x
})
const RUNS = { numRuns: Number(process.env.PROPERTY_RUNS) || 300 }

describe('mergeEntry on tied stamps (property)', () => {
  it('is commutative and associative', () => {
    fc.assert(fc.property(version, version, version, (a, b, c) => {
      expect(m(a, b)).toEqual(m(b, a))
      expect(m(m(a, b), c)).toEqual(m(a, m(b, c)))
      expect(m(m(a, b), b)).toEqual(m(a, b))
    }), RUNS)
  })
})
