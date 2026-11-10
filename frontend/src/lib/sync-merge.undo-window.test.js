/* An Undo overruled by changes it never saw (sync-merge.js "Undo", NATG-561 Tester finding 1). An
 * Undo marks the field with the window it undid, `(base, del)`; a change another device made inside
 * that window and never showed this one wins over the Undo. With two such changes on two devices,
 * the first to meet the Undo used to take its marker away, and the second could no longer win: the
 * result depended on the order. The overruled Undo now keeps `[base, del, at, won]`, and the field
 * ends up with the latest change inside the window, in every order. */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { markEntryUndone, mergeEntry, mergeStates, stampChange, stampEntry } from './sync-merge.js'

const clone = o => JSON.parse(JSON.stringify(o))
const m = (x, y) => mergeEntry(clone(x), clone(y))
const ms = (x, y) => mergeStates(clone(x), clone(y))
// Every way three copies can meet: each grouping, each order within it.
const orders3 = (A, B, C, merge) => [
  merge(merge(A, B), C), merge(A, merge(B, C)), merge(merge(B, A), C), merge(merge(C, A), B),
  merge(B, merge(C, A)), merge(C, merge(A, B)), merge(merge(A, C), B), merge(merge(C, B), A),
]
const allSame = xs => { for (const x of xs) expect(x).toEqual(xs[0]); return xs[0] }

// The Tester's scenario (natg-561-undo-repro.mjs): routine `r`, one bench exercise, three sets.
// B removes the exercise at T+100 and (with `del`) the routine at T+120; C makes it four sets at
// T+110; A removes the exercise at T+130 and puts it back with Undo at T+160, as RoutineEdit does.
const T = 1_800_000_000_000
const base = () => ({ unit: 'kg', _ts: T + 10, workouts: [], routines: [{ id: 'r', name: 'Push', ex: [{ id: 'bench', sets: 3 }], _ts: T + 10 }] })
const change = (S, t, fn) => { const x = clone(S); fn(x); x._ts = stampChange(S, x, T + t); return x }
function undoCopies(S0, { del = true } = {}) {
  const a0 = change(S0, 130, x => { x.routines[0].ex = [] })
  const A = change(a0, 160, x => {
    x.routines[0].ex = clone(S0.routines[0].ex)
    markEntryUndone(x.routines[0], 'ex', S0.routines[0]._f?.ex || 0, T + 130)
  })
  const b0 = change(S0, 100, x => { x.routines[0].ex = [] })
  const B = del ? change(b0, 120, x => { x.routines = [] }) : b0
  const C = change(S0, 110, x => { x.routines[0].ex[0].sets = 4 })
  return { A, B, C }
}

describe('an Undo two unseen changes overrule, on two other devices', () => {
  it('the routine B deleted and A brought back keeps C\'s four sets, in every order', () => {
    const { A, B, C } = undoCopies(base())
    expect(A.routines[0]._u).toEqual({ ex: [0, T + 130, T + 160] })
    const M = allSame(orders3(A, B, C, ms))
    expect(M.routines).toHaveLength(1)
    expect(M.routines[0].ex).toEqual([{ id: 'bench', sets: 4 }])
    expect(M.routines[0]._f.ex).toBe(T + 161)
    expect(M.routines[0]._u).toEqual({ ex: [0, T + 130, T + 161, T + 110] })
    expect(M.tombs).toBeUndefined()
  })

  it('the same without any removal of the routine', () => {
    const { A, B, C } = undoCopies(base(), { del: false })
    expect(allSame(orders3(A, B, C, ms)).routines[0].ex).toEqual([{ id: 'bench', sets: 4 }])
  })

  it('a setting: the later of two unseen changes wins over the Undo, in every order', () => {
    const A = { unit: 'kg', _ts: T + 160, restSec: 90, edited: { restSec: T + 160 }, undone: { restSec: [0, T + 130, T + 160] } }
    const B = { unit: 'kg', _ts: T + 100, restSec: 30, edited: { restSec: T + 100 } }
    const C = { unit: 'kg', _ts: T + 110, restSec: 45, edited: { restSec: T + 110 } }
    const M = allSame(orders3(A, B, C, ms).map(S => ({ restSec: S.restSec, edited: S.edited, undone: S.undone })))
    expect(M).toEqual({ restSec: 45, edited: { restSec: T + 161 }, undone: { restSec: [0, T + 130, T + 161, T + 110] } })
  })

  it('a change after the Undo still beats it, and one between the removal and the Undo still loses', () => {
    const U = { id: 'r', ex: 'undo', _ts: T + 160, _f: { ex: T + 160 }, _u: { ex: [0, T + 130, T + 160] } }
    const later = { id: 'r', ex: 'later', _ts: T + 170, _f: { ex: T + 170 } }
    const between = { id: 'r', ex: 'between', _ts: T + 140, _f: { ex: T + 140 } }
    const inside = { id: 'r', ex: 'inside', _ts: T + 100, _f: { ex: T + 100 } }
    expect(allSame(orders3(U, later, inside, m)).ex).toBe('later')
    expect(m(U, between).ex).toBe('undo')
    expect(m(between, U).ex).toBe('undo')
  })
})

describe('exact ties of the field\'s stamp (constraint c)', () => {
  const S = T + 50
  const plain = v => ({ id: 'r', ex: v, _ts: S, _f: { ex: S } })
  const undo = v => ({ id: 'r', ex: v, _ts: S, _f: { ex: S }, _u: { ex: [0, T + 30, S] } })
  const overruled = (v, won) => ({ id: 'r', ex: v, _ts: S, _f: { ex: S }, _u: { ex: [0, T + 30, S, won] } })
  const both = (x, y) => { const a = m(x, y), b = m(y, x); expect(a).toEqual(b); return a }

  it('an Undo wins over a plain value, either way round', () => {
    expect(both(undo('a'), plain('z')).ex).toBe('a')
  })
  it('an overruled Undo loses to a plain value, either way round', () => {
    const r = both(overruled('z', T + 10), plain('a'))
    expect(r.ex).toBe('a')
    expect(r._u).toBeUndefined()
  })
  it('two overruled Undos: the later `won`, then the higher value', () => {
    expect(both(overruled('a', T + 20), overruled('z', T + 10)).ex).toBe('a')
    expect(both(overruled('a', T + 20), overruled('z', T + 20)).ex).toBe('z')
  })
  it('an Undo wins over an overruled Undo, either way round', () => {
    const r = both(undo('a'), overruled('z', T + 10))
    expect(r.ex).toBe('a')
    expect(r._u).toEqual({ ex: [0, T + 30, S] })
  })
  it('inside the window, a change with the same stamp as `won` keeps the marker and the higher value wins', () => {
    const won = overruled('a', T + 10)
    const r = both({ ...won, _ts: T + 51, _f: { ex: T + 51 }, _u: { ex: [0, T + 30, T + 51, T + 10] } }, { id: 'r', ex: 'z', _ts: T + 10, _f: { ex: T + 10 } })
    expect(r.ex).toBe('z')
    expect(r._u).toEqual({ ex: [0, T + 30, T + 51, T + 10] })
  })
})

describe('an overruled Undo\'s marker through an edit (settleMarks, constraint d)', () => {
  const x = { id: 'r', ex: 'a', name: 'Push', _ts: T + 161, _f: { ex: T + 161 }, _u: { ex: [0, T + 130, T + 161, T + 110] } }
  it('stays while its field is not changed', () => {
    const next = stampEntry(clone(x), { ...clone(x), name: 'Pull' }, T + 200)
    expect(next._u).toEqual(x._u)
  })
  it('goes once its field is', () => {
    expect(stampEntry(clone(x), { ...clone(x), ex: 'b' }, T + 200)._u).toBeUndefined()
  })
})

// ---- Property: one Undo, the other copies' changes inside its window or after it ----------------
// Changes stamped from the removal up to the Undo (`[del, at]`) are left out on purpose: with a
// change inside the window, they are the case no rule that keeps one value per field can settle
// (NATG-697, "Undo" in sync-merge.js).
const BASE = T, DEL = T + 30, AT = T + 40
const VALUES = ['a', 'b', 'c', 3, [1, 2], { x: 1 }]
const plainChange = fc.record({
  v: fc.constantFrom(...VALUES),
  at: fc.oneof(fc.integer({ min: BASE + 1, max: DEL - 1 }), fc.integer({ min: AT + 1, max: AT + 6 })),
})
const RUNS = { numRuns: Number(process.env.PROPERTY_RUNS) || 300 }

describe('one Undo and unseen changes inside its window or after it (property)', () => {
  it('entries: every order of three or four copies gives the same field', () => {
    fc.assert(fc.property(fc.constantFrom(...VALUES), fc.array(plainChange, { minLength: 2, maxLength: 3 }), (uv, changes) => {
      const U = { id: 'r', ex: uv, _ts: AT, _f: { ex: AT }, _u: { ex: [BASE, DEL, AT] } }
      const others = changes.map(c => ({ id: 'r', ex: c.v, _ts: c.at, _f: { ex: c.at } }))
      const [P, Q, R] = others
      const results = R
        ? [m(m(m(U, P), Q), R), m(U, m(P, m(Q, R))), m(m(R, Q), m(P, U)), m(m(Q, U), m(R, P)), m(R, m(U, m(Q, P)))]
        : orders3(U, P, Q, m)
      allSame(results)
      for (const x of others) expect(m(U, x)).toEqual(m(x, U))
    }), RUNS)
  })

  // Two settings changes with exactly the same stamp keep the newer copy's, as they did before this
  // issue (only entries settle such a tie by value, mergeEntry "Exact ties"), so the two plain
  // changes here never share a stamp.
  it('settings: the same through mergeStates', () => {
    fc.assert(fc.property(fc.constantFrom(...VALUES), fc.uniqueArray(plainChange, { minLength: 2, maxLength: 2, selector: c => c.at }), (uv, [p, q]) => {
      const S = (v, at, undone) => ({ unit: 'kg', _ts: at, restSec: v, edited: { restSec: at }, ...(undone ? { undone: { restSec: undone } } : {}) })
      const U = S(uv, AT, [BASE, DEL, AT]), P = S(p.v, p.at), Q = S(q.v, q.at)
      allSame(orders3(U, P, Q, ms).map(X => ({ restSec: X.restSec, edited: X.edited, undone: X.undone })))
    }), RUNS)
  })
})
