import { describe, it, expect } from 'vitest'
import { finishCompare, trendOf } from './finish-compare.js'
import { sharedView } from './shared-routines.js'

const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra })
const routine = { id: 'r1', name: 'A', prog: 'linear', ex: [{ id: 'bench', sets: 3, reps: 5, weight: 60, mode: 'reps' }] }
const workout = (id, d, sets, more = {}) => ({ id, d, start: Date.parse(d + 'T10:00:00'), end: Date.parse(d + 'T11:00:00'),
  entries: [{ id: 'bench', rid: 'r1', target: { ...routine.ex[0] }, sets }], ...more })

describe('last time and next time on the finish summary (#324)', () => {
  it('compares by the heaviest set, then by reps', () => {
    expect(trendOf([set(62.5, 5)], [set(60, 6)])).toBe(1)
    expect(trendOf([set(60, 5), set(60, 5)], [set(60, 5), set(60, 6)])).toBe(-1)
    expect(trendOf([set(60, 5)], [set(60, 5)])).toBe(0)
    expect(trendOf([set(60, 5)], null)).toBeNull()
  })
  it('finds the previous session of the exercise and leaves warm-ups out', () => {
    const prev = workout('w1', '2026-10-01', [set(20, 5, { phase: 'warmup' }), set(60, 5), set(60, 5), set(60, 4)])
    const now = workout('w2', '2026-10-03', [set(60, 5), set(60, 5), set(60, 5)])
    const st = { unit: 'kg', routines: [routine], workouts: [prev, now], exWeights: {} }
    const [row] = finishCompare(st, now)
    expect(row.last).toEqual([{ w: 60, r: 5 }, { w: 60, r: 5 }, { w: 60, r: 4 }])
    expect(row.trend).toBe(1)
    expect(row.next).toBeTruthy()
    expect(row.next.w).toBeGreaterThanOrEqual(60)
  })
  it('a first time has no last, and a workout out of progression has no next', () => {
    const now = workout('w1', '2026-10-03', [set(60, 5)], { noProg: true })
    const [row] = finishCompare({ unit: 'kg', routines: [routine], workouts: [now] }, now)
    expect(row.last).toBeNull()
    expect(row.trend).toBeNull()
    expect(row.next).toBeNull()
  })
})

// NATG-486: an exercise from a routine shared with you gets its "next time" like one of your own.
describe('the finish summary for a routine shared with you', () => {
  const shared = sharedView({ uid: 'u2', outgoing: [], etag: 'e', incoming: [{
    id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h',
    routine: { id: 'r9', name: 'Leg Day', prog: 'linear', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60, mode: 'reps' }] },
  }] }, { id: 'u2' }, 'kg')
  const now = { id: 'w1', d: '2026-10-03', start: Date.parse('2026-10-03T10:00:00'), end: Date.parse('2026-10-03T11:00:00'),
    entries: [{ id: '0025', rid: 'shared:s1', target: { sets: 3, reps: 5, weight: 60, mode: 'reps' }, sets: [set(60, 5), set(60, 5), set(60, 5)] }] }
  const st = { unit: 'kg', routines: [], workouts: [now], exWeights: {} }
  it('resolves the shared rid and says what the next session opens at', () => {
    const [row] = finishCompare(st, now, shared)
    expect(row.next).toBeTruthy()
    expect(row.next.w).toBeGreaterThanOrEqual(60)
  })
  it('without the shared routines it has no next, as before', () => {
    expect(finishCompare(st, now)[0].next).toBeNull()
  })
})
