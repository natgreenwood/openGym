/* The content of removed entries (sync-merge.js `tombs`, NATG-561). One copy removes an entry,
 * another edited a field of it before the removal, a third edits it after (which brings it back):
 * every copy must end up with the same entry, holding the latest value of every field from every
 * copy, whichever two copies meet first. */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  mergeStates, mergeTombs, pruneTombs, sinceReset, stampChange, stampDeletions, stampReplace, stampWorkout,
  TOMB_KEEP_MS, TOMB_LISTS, TOMB_MAX,
} from './sync-merge.js'
import { convertStateUnit, convertWeight } from './units.js'

const clone = o => JSON.parse(JSON.stringify(o))
const merge = (a, b) => mergeStates(clone(a), clone(b))
// Every way three copies can meet: each grouping, each order within it.
const orders3 = (A, B, C) => [
  merge(merge(A, B), C), merge(A, merge(B, C)), merge(merge(B, A), C), merge(merge(C, A), B),
  merge(B, merge(C, A)), merge(C, merge(A, B)), merge(merge(A, C), B), merge(merge(C, B), A),
]
const allSame = xs => { for (const x of xs) expect(x).toEqual(xs[0]); return xs[0] }

const base = () => ({
  unit: 'kg', _ts: 10, restSec: 90, favEx: [], bodyweight: [], measurements: [], exWeights: {},
  workouts: [{ id: 'w0', d: '2026-09-30', start: 1000, end: 2000, entries: [{ id: 'bench', sets: [{ w: 60, r: 5 }] }] }],
  routines: [{ id: 'r0', name: 'Push', ex: [{ id: 'bench', sets: 3 }], _ts: 5 }],
  customEx: [{ id: 'c0', name: 'Sandbag carry', custom: true, _ts: 5 }],
  gymCards: [{ id: 'g0', name: 'Gym', value: '123', _ts: 5 }],
  equipProfiles: [{ id: 'e0', name: 'Home', _ts: 5 }],
})
// A change the way the store makes one (useStore update): a mutation, then stampChange.
const change = (prev, wall, mut) => { const n = clone(prev); mut(n); n._ts = stampChange(prev, n, wall); return n }

describe('the three operations the research reduced it to (AC1, AC3)', () => {
  // A: a note on the workout at 100060, after the removal. B: a set added at 100041, before it.
  // C: the workout removed at 100052.
  const note = change(base(), 100060, S => { S.workouts[0].note = 'keep this note'; stampWorkout(S.workouts[0], 100060) })
  const set = change(base(), 100041, S => { S.workouts[0].entries[0].sets.push({ w: 20, r: 1 }); stampWorkout(S.workouts[0], 100041) })
  const del = change(base(), 100052, S => { S.workouts = [] })

  it('gives the same document in every merge order', () => {
    allSame(orders3(note, set, del))
  })

  it('brings the workout back with the note and both sets', () => {
    for (const M of orders3(note, set, del)) {
      expect(M.workouts).toHaveLength(1)
      expect(M.workouts[0].note).toBe('keep this note')
      expect(M.workouts[0].entries[0].sets).toEqual([{ w: 60, r: 5 }, { w: 20, r: 1 }])
      expect(M.tombs).toBeUndefined()   // what was kept went back into the entry
      expect(M.deleted.workouts.w0).toBe(100052)
    }
  })

  it('keeps the removed version while nothing brings it back, and gives it back to a later edit', () => {
    const SC = merge(set, del)
    expect(SC.workouts).toEqual([])
    expect(SC.tombs.workouts.w0).toEqual({ _f: { entries: 100041 }, entries: [{ id: 'bench', sets: [{ w: 60, r: 5 }, { w: 20, r: 1 }] }] })
    expect(merge(note, SC).workouts[0].entries[0].sets).toHaveLength(2)
  })

  it('the generator-valid minimum from the property test converges too', () => {
    const play = (dev, ops) => ops.reduce((S, o, i) => change(S, 100000 + (i + 1) * 30 + dev * 11, o), base())
    const A = play(0, [S => { S.workouts[0].entries[0].sets.push({ w: 20, r: 1 }); stampWorkout(S.workouts[0], 100030) }])
    const B = play(1, [S => { S.workouts = [] }])
    const C = play(2, [S => { S.workouts[0].entries[0].sets[0].w = 60; stampWorkout(S.workouts[0], 100052) }])
    const M = allSame(orders3(A, B, C))
    expect(M.workouts[0].entries[0].sets).toEqual([{ w: 60, r: 5 }, { w: 20, r: 1 }])
  })
})

describe('every list that is merged field by field (AC4)', () => {
  const lists = { routines: 'r0', customEx: 'c0', gymCards: 'g0', equipProfiles: 'e0' }
  for (const [f, id] of Object.entries(lists)) {
    it(`${f}: a field edited before the removal survives an edit after it, in every order`, () => {
      const before = change(base(), 100041, S => { S[f][0].note = 'before' })
      const del = change(base(), 100052, S => { S[f] = [] })
      const after = change(base(), 100060, S => { S[f][0].name = 'after' })
      const M = allSame(orders3(before, del, after))
      expect(M[f].find(x => x.id === id)).toMatchObject({ note: 'before', name: 'after' })
      expect(M.tombs).toBeUndefined()
    })
  }

  it('keeps nothing of a removed weigh-in, measurement or favourite: those merge as before', () => {
    const S = { ...base(), bodyweight: [{ d: '2026-10-01', w: 80, t: 5 }], measurements: [{ d: '2026-10-01', waist: 80, t: 5 }], favEx: ['bench'] }
    const gone = change(S, 100052, X => { X.bodyweight = []; X.measurements = []; X.favEx = [] })
    expect(gone.tombs).toBeUndefined()
    expect(Object.keys(merge(S, gone).tombs || {})).toEqual([])
    expect(Object.keys(TOMB_LISTS).sort()).toEqual(['customEx', 'equipProfiles', 'gymCards', 'routines', 'workouts'])
  })

  it('keeps a removed workout\'s photos, and they come back with it', () => {
    const photo = { kind: 'image', hash: 'a'.repeat(64), mime: 'image/webp', size: 10, width: 1, height: 1, at: 1 }
    const withPhoto = change(base(), 100041, S => { S.workouts[0].media = [photo]; stampWorkout(S.workouts[0], 100041) })
    const del = change(base(), 100052, S => { S.workouts = [] })
    const after = change(base(), 100060, S => { S.workouts[0].note = 'n'; stampWorkout(S.workouts[0], 100060) })
    expect(merge(withPhoto, del).tombs.workouts.w0.media).toEqual([photo])
    for (const M of orders3(withPhoto, del, after)) expect(M.workouts[0].media).toEqual([photo])
  })
})

describe('a removal on this device keeps the content too (stampDeletions)', () => {
  it('keeps the stamped fields of the entry it removed, and none of a never-edited one', () => {
    const edited = change(base(), 100041, S => { S.routines[0].name = 'Push day' })
    const gone = change(edited, 100052, S => { S.routines = []; S.workouts = [] })
    expect(gone.tombs).toEqual({ routines: { r0: { _f: { name: 100041 }, name: 'Push day' } } })
  })

  it('never writes into the previous copy', () => {
    const edited = change(change(base(), 100041, S => { S.routines[0].name = 'A' }), 100045, S => { S.customEx[0].name = 'B'; S.customEx = [] })
    const json = JSON.stringify(edited)
    change(edited, 100052, S => { S.routines = [] })
    expect(JSON.stringify(edited)).toBe(json)
  })
})

describe('retention (AC5) and the cap (AC6)', () => {
  const DAY = 86400000
  const T = 1_800_000_000_000
  const tomb = id => ({ _f: { name: 1 }, name: id })

  it('drops kept content 30 days after the removal, when a change is stamped', () => {
    expect(TOMB_KEEP_MS).toBe(30 * DAY)
    const S = { workouts: [], deleted: { routines: { old: T - 31 * DAY, young: T - 29 * DAY } }, tombs: { routines: { old: tomb('old'), young: tomb('young') } } }
    const next = stampDeletions(S, clone(S), T)
    expect(Object.keys(next.tombs.routines)).toEqual(['young'])
  })

  it('never drops by age inside the merge', () => {
    const S = { _ts: T, routines: [], deleted: { routines: { old: 5 } }, tombs: { routines: { old: tomb('old') } } }
    expect(merge(S, { _ts: T + 1, routines: [] }).tombs.routines.old).toEqual(tomb('old'))
  })

  it('keeps the newest 200 per list by removal, ties by key, whatever order the copies meet in', () => {
    const del = {}, a = {}, b = {}
    for (let i = 0; i < 260; i++) {
      const k = `r${String(i).padStart(3, '0')}`
      del[k] = 1000 + Math.floor(i / 2)   // pairs of equal stamps
      ;(i % 2 ? a : b)[k] = tomb(k)
    }
    const deleted = { routines: del }
    const ab = mergeTombs({ routines: a }, { routines: b }, deleted), ba = mergeTombs({ routines: b }, { routines: a }, deleted)
    expect(ab).toEqual(ba)
    expect(Object.keys(ab.routines)).toHaveLength(TOMB_MAX)
    expect(ab.routines.r259).toBeTruthy()
    expect(ab.routines.r059).toBeUndefined()
    expect(ab.routines.r060).toBeTruthy()
  })

  it('treats anything that is not a map of maps of entries as nothing', () => {
    expect(mergeTombs('x', [1], {})).toEqual({})
    expect(mergeTombs({ routines: [tomb('a')], bodyweight: { x: tomb('x') } }, { workouts: { w: 3, v: null } }, {})).toEqual({})
    expect(pruneTombs('x', {}, T)).toBe(null)
  })
})

describe('"Reset everything" (AC7)', () => {
  it('leaves no kept content in a copy that has not seen the reset, nor in the merge with it', () => {
    const del = change(change(base(), 100041, S => { S.routines[0].name = 'Push day' }), 100052, S => { S.routines = [] })
    expect(del.tombs.routines.r0).toBeTruthy()
    expect(sinceReset(del, 100060, { routines: ['r0'] }).tombs).toBeUndefined()
    const reset = { unit: 'kg', _ts: 100070, resetAt: 100070, resetIds: { routines: ['r0'] }, workouts: [], routines: [] }
    expect(merge(del, reset).tombs).toBeUndefined()
    expect(merge(reset, del).tombs).toBeUndefined()
  })
})

describe('kept content in another unit', () => {
  it('is converted with the copy, and the sets come back in the merged copy\'s unit', () => {
    const set = change(base(), 100041, S => { S.workouts[0].entries[0].sets.push({ w: 100, r: 1 }); stampWorkout(S.workouts[0], 100041) })
    const del = change(base(), 100052, S => { S.workouts = [] })
    const kept = merge(set, del)
    const lb = convertStateUnit(kept, 'lb')
    expect(lb.tombs.workouts.w0.entries[0].sets[1].w).toBe(convertWeight(100, 'kg', 'lb'))
    expect(lb.tombs.workouts.w0._f).toEqual(kept.tombs.workouts.w0._f)
    const after = convertStateUnit(change(base(), 100060, S => { S.workouts[0].note = 'n'; stampWorkout(S.workouts[0], 100060) }), 'lb')
    expect(merge(after, lb).workouts[0].entries[0].sets[1].w).toBe(convertWeight(100, 'kg', 'lb'))
  })
})

describe('a backup that replaces the profile wins over what was kept of its entries too', () => {
  it('stamps the backup\'s fields that differ from a kept version (stampReplace)', () => {
    const server = { ...base(), routines: [], tombs: { routines: { r0: { _f: { name: 900 }, name: 'Kept' } } }, deleted: { routines: { r0: 950 } } }
    const backup = { ...base(), routines: [{ id: 'r0', name: 'From backup', ex: [], _ts: 5 }] }
    stampReplace(backup, [server], 1000)
    expect(backup.routines[0]._f.name).toBe(1000)
    expect(merge(backup, server).routines[0].name).toBe('From backup')
  })
})

// ---- Three copies, five lists, clocks that tie (AC10) -------------------------------------------
const LISTS = ['workouts', 'routines', 'customEx', 'gymCards', 'equipProfiles']
const VALUES = ['a', 'b', 'c']
const op = fc.oneof(
  fc.record({ k: fc.constant('edit'), f: fc.constantFrom(...LISTS), field: fc.constantFrom('name', 'note'), v: fc.constantFrom(...VALUES) }),
  fc.record({ k: fc.constant('set'), w: fc.integer({ min: 20, max: 40 }) }),
  fc.record({ k: fc.constant('del'), f: fc.constantFrom(...LISTS) }),
)
// `tie`: every device's clock reads the same at the same step, so changes made on different devices
// carry equal stamps (stampChange lifts each past what its own copy carries).
function play(ops, dev, tie) {
  let S = base()
  ops.forEach((o, i) => {
    const wall = 100000 + (i + 1) * 30 + (tie ? 0 : dev * 10 + dev)
    S = change(S, wall, X => {
      if (o.k === 'del') { X[o.f] = []; return }
      if (o.k === 'set') {
        const w = X.workouts[0]
        if (!w) return
        w.entries[0].sets.push({ w: o.w, r: 1 })
        stampWorkout(w, wall)
        return
      }
      const x = X[o.f][0]
      if (!x) return
      x[o.field] = o.v
      if (o.f === 'workouts') stampWorkout(x, wall)
    })
  })
  return S
}
const docOf = M => {
  const out = {}
  for (const f of [...LISTS, 'tombs', 'deleted']) out[f] = M[f]
  return out
}
const RUNS = { numRuns: Number(process.env.PROPERTY_RUNS) || 150 }

describe('three copies over the five lists, equal stamps included (property)', () => {
  it('end up the same whichever two meet first, and whichever merges into which', () => {
    fc.assert(fc.property(fc.array(fc.array(op, { maxLength: 6 }), { minLength: 3, maxLength: 3 }), fc.boolean(), ([oa, ob, oc], tie) => {
      const [A, B, C] = [oa, ob, oc].map((o, i) => play(o, i, tie))
      const all = orders3(A, B, C).map(docOf)
      for (const x of all) expect(x).toEqual(all[0])
      expect(docOf(merge(A, B))).toEqual(docOf(merge(B, A)))
    }), RUNS)
  })
})
