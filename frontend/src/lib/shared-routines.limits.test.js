// SEC-486-01: a sharer controls the counts in a routine shared with you. Every count that drives
// a loop must be a whole number within lib/limits.js, and the rows a routine starts with stay
// within MAX_ROUTINE_ROWS; a share outside them is not available (shown with the reason, never
// started, days kept). Judged before anything is copied or built, so a huge count costs nothing.
// The builders clamp to the same limits too, whatever the routine.
import { describe, expect, it } from 'vitest'
import { withinLimits, sharedRoutineOf, sharedView, unavailableOf } from './shared-routines.js'
import { MAX_WORK_SETS, MAX_BURST_REPS, MAX_DROPS, MAX_ROUTINE_ROWS } from './limits.js'
import { LOG_LIMITS } from './log-workout.js'
import { exLine, buildSets, applyIntensifierPlan } from './history.js'
import { backoffWeights } from './backoff.js'

const slot = over => ({ id: '0025', sets: 3, reps: 5, weight: 100, ...over })
const routine = (...ex) => ({ id: 'r9', name: 'Leg Day', ex })
const accepted = (r, id = 's1') => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h-' + id + JSON.stringify(r).length, routine: r })
const fast = fn => { const t0 = performance.now(); const out = fn(); return { out, ms: performance.now() - t0 } }

describe('the limits', () => {
  it('are the bounds a logged workout is already held to', () => {
    expect(MAX_WORK_SETS).toBe(LOG_LIMITS.maxSets)
    expect(MAX_BURST_REPS).toBe(LOG_LIMITS.maxReps)
    expect(MAX_DROPS).toBe(10)
    expect(MAX_ROUTINE_ROWS).toBe(500)
  })
})

describe('withinLimits: judged before anything is built', () => {
  it('takes an ordinary routine, and a slot whose sets are unset or 0', () => {
    expect(withinLimits(routine(slot(), slot({ sets: undefined }), slot({ sets: 0 }), slot({ intensifier: { type: 'dropset', count: 3, pct: 20 } })))).toBe(true)
  })
  it.each([
    ['a hundred million sets', slot({ sets: 100000000, backoff: true })],
    ['more sets than the limit', slot({ sets: MAX_WORK_SETS + 1 })],
    ['a fractional set count', slot({ sets: 3.5 })],
    ['a negative set count', slot({ sets: -2 })],
    ['a set count as text', slot({ sets: '5' })],
    ['a drop set with a billion drops', slot({ intensifier: { type: 'dropset', count: 1e9, pct: 20 } })],
    ['a drop count as text', slot({ intensifier: { type: 'dropset', count: '1e9', pct: 20 } })],
    ['a rest-pause set of a billion reps', slot({ intensifier: { type: 'restpause', totalReps: 1e9, restSec: 15 } })],
    ['a triple-progression ceiling past its cap', slot({ setsMax: 1e6 })],
    ['a pyramid longer than its cap', slot({ pyramid: Array(11).fill(5) })],
    ['a list of a thousand warm-up rows', slot({ warmupSets: Array(1000).fill({}) })],
  ])('rejects %s', (_, s) => {
    expect(withinLimits(routine(s))).toBe(false)
  })
  it('caps the rows the whole routine would start with', () => {
    // 11 exercises of 50 sets: each fine alone, 550 rows together.
    expect(withinLimits(routine(...Array(10).fill(slot({ sets: 50 }))))).toBe(true)
    expect(withinLimits(routine(...Array(11).fill(slot({ sets: 50 }))))).toBe(false)
    // Drops multiply the rows: 50 sets of 10 drops is 550.
    expect(withinLimits(routine(slot({ sets: 50, intensifier: { type: 'dropset', count: 10, pct: 10 } })))).toBe(false)
  })
  it('rejects a list of a hundred million exercises from its length alone, without walking it', () => {
    const { out, ms } = fast(() => withinLimits({ ex: new Array(1e8) }))
    expect(out).toBe(false)
    expect(ms).toBeLessThan(50)
  })
})

describe('a share outside the limits is not available', () => {
  const huge = routine(slot({ sets: 100000000, backoff: true }))
  it('gives no routine, at once', () => {
    const { out, ms } = fast(() => sharedRoutineOf(accepted(huge), 'kg'))
    expect(out).toBeNull()
    expect(ms).toBeLessThan(50)
  })
  it('is listed as not available, too large, and never as a usable routine', () => {
    const v = sharedView({ uid: 'u2', incoming: [accepted(huge, 's7')], outgoing: [], etag: 'e', names: { s7: 'Leg Day' } }, { id: 'u2' }, 'kg')
    expect(v.routines).toEqual([])
    expect(v.ids.has('shared:s7')).toBe(false)
    expect(unavailableOf(v, 'shared:s7')).toMatchObject({ reason: 'too-large', name: 'Leg Day' })
  })
})

describe('the builders clamp too (defence in depth)', () => {
  it('exLine writes at most MAX_WORK_SETS back-off weights', () => {
    const { out, ms } = fast(() => exLine({ id: '0025', sets: 100000000, reps: 5, weight: 100, backoff: true }, 'kg'))
    expect(ms).toBeLessThan(200)
    expect(out.split('→').length).toBeLessThanOrEqual(MAX_WORK_SETS)
  })
  it('backoffWeights never allocates past MAX_WORK_SETS', () => {
    expect(backoffWeights(100, 1e9, 2.5)).toHaveLength(MAX_WORK_SETS)
  })
  it('a session is built with at most MAX_WORK_SETS rows and MAX_DROPS drops per row', () => {
    const S = { unit: 'kg', workouts: [], exWeights: {} }
    const cfg = { id: '0025', sets: 100000000, reps: 5, weight: 100, intensifier: { type: 'dropset', count: 1e9, pct: 10 } }
    const rows = applyIntensifierPlan(buildSets(S, cfg), cfg)
    expect(rows.length).toBeLessThanOrEqual(MAX_WORK_SETS)
    expect(Math.max(...rows.map(r => r.drops?.length || 0))).toBeLessThanOrEqual(MAX_DROPS)
  })
})
