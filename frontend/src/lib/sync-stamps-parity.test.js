/* api/sync-stamps.js is a hand copy of the stamping rules here (sync-merge.js), for the server's
   PUT /api/data. The two must agree; and what the server stamps for a writer that does not stamp
   its own changes (an older app, an API planner) must hold in this side's merge. */
import { describe, expect, it } from 'vitest'
import * as S from '../../../api/sync-stamps.js'
import { highestStamp, mergeDeletions, mergeEdits, mergeEntry, mergeStates, mergeTombs, pruneTombs, stampChange, stampEntry, stampEdits, stampRestore, TOMB_KEEP_MS, TOMB_LISTS, TOMB_MAX } from './sync-merge.js'

const clone = v => JSON.parse(JSON.stringify(v))
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }

describe('api/sync-stamps.js matches sync-merge.js', () => {
  it('on random records and entries', () => {
    for (let seed = 1; seed < 300; seed++) {
      const R = rng(seed)
      const n = () => Math.floor(R() * 1000) * (R() < 0.3 ? -1 : 1)
      const recs = () => ({ workouts: { a: n(), b: n() }, favEx: { x: n() }, bodyweight: R() < 0.5 ? { '2026-10-01': n() } : undefined })
      const a = recs(), b = recs()
      expect(S.mergeDeletions(a, b)).toEqual(mergeDeletions(a, b))
      const ea = { restSec: n(), 'week.1': n() }, eb = { restSec: n(), queue: n() }
      expect(S.mergeEdits(ea, eb)).toEqual(mergeEdits(ea, eb))
      const doc = { _ts: n(), edited: ea, deleted: a, routines: [{ id: 'r', _ts: n(), _f: { name: n() } }], plates: { kg: { _ts: n() } } }
      expect(S.highestStamp(doc)).toBe(highestStamp(doc))
      const old = { id: 'r', name: 'A', ex: [1], _f: { ex: 5 }, ...(R() < 0.5 ? { _u: { ex: [1, 5, 5] } } : {}) }
      const x = { id: 'r', name: R() < 0.5 ? 'A' : 'B', ex: [1, R() < 0.5 ? 2 : 1], ...(R() < 0.3 ? { _u: { name: [0, 4], ex: [1, 5, 5] } } : {}) }
      expect(S.stampEntry(clone(old), clone(x), 99)).toEqual(stampEntry(clone(old), clone(x), 99))
    }
  })

  it('merges two versions of an entry the same, exact ties and Undo markers included', () => {
    const vals = [undefined, 'A', 'B', 3, { sets: 3, reps: 5 }, { reps: 5, sets: 3 }, [1, 2]]
    for (let seed = 1; seed < 500; seed++) {
      const R = rng(seed)
      const pick = xs => xs[Math.floor(R() * xs.length)]
      const version = () => {
        const x = { id: 'r' }, f = {}
        for (const k of ['name', 'ex', 'note']) {
          const v = pick(vals)
          if (v !== undefined) x[k] = clone(v)
          if (R() < 0.7) f[k] = 1 + Math.floor(R() * 3)
        }
        if (Object.keys(f).length) x._f = f
        if (R() < 0.3 && f.ex) x._u = { ex: [0, f.ex - 1 || 1, f.ex] }
        x._ts = Math.max(Math.floor(R() * 4), ...Object.values(f))
        return x
      }
      const a = version(), b = version()
      expect(S.mergeEntry(clone(a), clone(b))).toEqual(mergeEntry(clone(a), clone(b)))
      expect(S.mergeEntry(clone(b), clone(a))).toEqual(mergeEntry(clone(b), clone(a)))
    }
  })

  it('joins, caps and ages out the kept content of removed entries the same', () => {
    expect([S.TOMB_MAX, S.TOMB_KEEP_MS, Object.keys(S.TOMB_LISTS)]).toEqual([TOMB_MAX, TOMB_KEEP_MS, Object.keys(TOMB_LISTS)])
    const DAY = 86400000, T = 1_800_000_000_000
    for (let seed = 1; seed < 60; seed++) {
      const R = rng(seed)
      const pick = xs => xs[Math.floor(R() * xs.length)]
      const media = () => ({ hash: pick(['a', 'b', 'c']).repeat(64), kind: 'image' })
      const entry = (f, id) => {
        const x = { id, _f: { note: 1 + Math.floor(R() * 3) }, note: pick(['x', 'y', 'z']) }
        if (f === 'workouts' && R() < 0.5) x.media = [media(), media()]
        if (R() < 0.2) x.extra = 'unstamped'
        return x
      }
      const side = () => {
        const out = {}
        for (const f of [...Object.keys(TOMB_LISTS), 'bodyweight']) {
          if (R() < 0.3) continue
          out[f] = {}
          for (let i = 0; i < 1 + Math.floor(R() * 260); i++) out[f][`k${Math.floor(R() * 300)}`] = R() < 0.05 ? 'junk' : entry(f, `k${i}`)
        }
        return out
      }
      const del = {}
      for (const f of Object.keys(TOMB_LISTS)) {
        del[f] = {}
        for (let i = 0; i < 300; i++) if (R() < 0.9) del[f][`k${i}`] = (T - Math.floor(R() * 40) * DAY) * (R() < 0.1 ? -1 : 1)
      }
      const a = side(), b = side()
      const mine = mergeTombs(clone(a), clone(b), del)
      expect(S.mergeTombs(clone(a), clone(b), del)).toEqual(mine)
      expect(mergeTombs(clone(b), clone(a), del)).toEqual(mine)
      expect(S.pruneTombs(clone(mine), del, T)).toEqual(pruneTombs(clone(mine), del, T))
    }
  })
})

describe('a removal and an add-back with the same stamp', () => {
  // QA round 2 (2026-10-06): two phones lifted their clocks from one highest stamp, so one's Undo
  // (-H-2) and the other's removal (+H-2) tied, and the first argument won: the device (local
  // first) and the server (stored first) kept opposite records.
  const H = 1_800_000_000_000
  it('merges the same in either order, on both sides: the add-back wins', () => {
    const a = { routines: { R: -(H + 2) } }, b = { routines: { R: H + 2 } }
    for (const f of [mergeDeletions, S.mergeDeletions]) {
      expect(f(a, b)).toEqual({ routines: { R: -(H + 2) } })
      expect(f(b, a)).toEqual({ routines: { R: -(H + 2) } })
    }
  })
  it('the routine put back with Undo is kept whichever phone merges first', () => {
    const R = { id: 'R', name: 'Push', ex: [], _ts: H - 10 }
    const base = { _ts: H, unit: 'kg', workouts: [], routines: [R], week: { 1: ['R'] } }
    const A = { ...clone(base), routines: [{ ...R, _ts: H + 2 }], deleted: { routines: { R: -(H + 2) } } }
    const B = { ...clone(base), routines: [], week: {}, deleted: { routines: { R: H + 2 } } }
    const ab = mergeStates(A, B), ba = mergeStates(B, A)
    expect(ab.deleted).toEqual(ba.deleted)
    expect(ab.routines.map(r => r.id)).toEqual(['R'])
    expect(ba.routines.map(r => r.id)).toEqual(['R'])
  })
})

describe('what the server stamps holds in the merge', () => {
  const T = 1_800_000_000_000
  const change = (prev, wall, mut) => { const n = clone(prev); mut(n); n._ts = stampChange(prev, n, wall); return n }
  const doc0 = () => ({ _ts: T, restSec: 90, queue: { label: 'US W1' }, edited: { queue: T },
    routines: [{ id: 'r1', name: 'A', ex: [], _ts: T }, { id: 'r2', name: 'B', ex: [], _ts: T }],
    workouts: [{ id: 'w1', d: '2026-10-01', start: T - 2e6, end: T - 1e6 }], favEx: [] })

  it('a planner\'s new week and removed routine survive a phone that reconnects with an older change', () => {
    const cur = doc0()
    const phone = change(cur, T + 60e3, S2 => { S2.workouts.push({ id: 'w2', d: '2026-10-06', start: T, end: T + 60e3 }) })   // offline
    const planned = clone(cur)
    planned.queue = { label: 'US W2' }
    planned.routines = planned.routines.filter(r => r.id !== 'r2')
    planned._ts = T + 30e3
    S.stampPut(cur, planned, { overRead: true, now: T + 30e3 })
    // the phone's later push gets the 409 and merges (phone's _ts is newer)
    const m = mergeStates(phone, planned)
    expect(m.queue).toEqual({ label: 'US W2' })
    expect(m.routines.map(r => r.id)).toEqual(['r1'])
    expect(m.workouts.map(w => w.id).sort()).toEqual(['w1', 'w2'])
  })

  it('an older app\'s offline delete and setting hold against an older change from an updated device', () => {
    const cur = doc0()
    const rc = change(cur, T + 5000, S2 => { S2.restSec = 60 })        // updated device, offline, not pushed yet
    const old = clone(cur); delete old.edited
    old.restSec = 180; old.workouts = []; old._ts = T + 9000              // v1.3.9, later
    S.stampPut(cur, old, { overRead: true, now: T + 9000 })
    const m = mergeStates(rc, old)
    expect(m.restSec).toBe(180)
    expect(m.workouts).toEqual([])
  })

  it('an older app\'s push keeps the removals on record, and an entry it brings back stays', () => {
    const cur = change(doc0(), T + 1000, S2 => { S2.workouts = [] })    // the RC deleted w1
    const old = clone(doc0()); delete old.edited                       // v1.3.9 offline, union brings w1 back
    old.favEx = []; old._ts = T + 2000
    S.stampPut(cur, old, { overRead: true, now: T + 2000 })
    expect(Object.keys(old.deleted.workouts)).toEqual(['w1'])
    expect(old.deleted.workouts.w1).toBeLessThan(0)   // kept, as added back: never flips back and forth
    const rcAgain = change(cur, T + 1500, S2 => { S2.restSec = 70 })
    expect(mergeStates(rcAgain, old).workouts.map(w => w.id)).toEqual(['w1'])
    expect(mergeStates(old, rcAgain).workouts.map(w => w.id)).toEqual(['w1'])
  })

  // RC review 2026-10-07: v1.3.9's exercise sheet saved a routine without the pyramid it does not
  // know, and the updated phone took that on its next merge.
  it('an older app\'s routine save keeps the pyramid on the updated phone too', () => {
    const cur = doc0()
    cur.routines[0].ex = [{ id: 'sq', sets: 4, reps: 12, weight: 40, pyramid: [12, 10, 8, 'max'] }]
    const rc = change(cur, T + 5000, S2 => { S2.restSec = 75 })   // the updated phone, not pushed yet
    const old = clone(cur); delete old.edited
    old.routines[0].ex = [{ id: 'sq', sets: 4, reps: 12, weight: 45 }]; old._ts = T + 9000
    S.stampPut(cur, old, { overRead: true, now: T + 9000 })
    for (const m of [mergeStates(rc, old), mergeStates(old, rc)]) {
      expect(m.routines[0].ex).toEqual([{ id: 'sq', sets: 4, reps: 12, weight: 45, pyramid: [12, 10, 8, 'max'] }])
      expect(m.restSec).toBe(75)
    }
  })

  // RC review 2026-10-07: an older app back from offline set the rest timer back on every device.
  it('an older app\'s older copy after a dead spot does not undo a setting the updated phone changed since', () => {
    const cur = change(doc0(), T + 1000, S2 => { S2.restSec = 60 })     // the updated phone, pushed
    const old = clone(doc0()); old.restSec = 90; old._ts = T + 9000         // v1.3.9 merged its older copy
    old.workouts.push({ id: 'w9', d: '2026-10-07', start: T + 8000, end: T + 9000 })
    S.stampPut(cur, old, { overRead: true, now: T + 9000 })
    expect(old.restSec).toBe(60)
    const later = change(cur, T + 2000, S2 => { S2.queue = { label: 'US W3' } })   // the phone, offline meanwhile
    for (const m of [mergeStates(later, old), mergeStates(old, later)]) {
      expect(m.restSec).toBe(60)
      expect(m.workouts.map(w => w.id).sort()).toEqual(['w1', 'w9'])
    }
  })
})

describe('the write ids are no setting', () => {
  it('neither a change nor a restored backup stamps them', () => {
    const prev = { _ts: 1, _wid: 'a', _wids: ['x'], restSec: 90 }
    const next = { ...clone(prev), _wid: 'b', _wids: ['x', 'a'] }
    expect(stampEdits(prev, next, 5).edited).toBeUndefined()
    expect(Object.keys(stampRestore({ _wid: 'b', _wids: ['a'], restSec: 60 }, [], 9).edited)).not.toContain('_wid')
  })
})

