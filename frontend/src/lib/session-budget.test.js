// SEC-486-01, the rest: MAX_ROUTINE_ROWS means what it says. A routine's rows are counted the
// way the builders generate them (history.js rowPlan: a timed per-side set is two rows, warm-ups,
// drops, bursts and a triple progression's ceiling count too), and one session is held to the same
// budget however its routines come together. Each refusal happens before a row is built.
import { describe, expect, it, vi } from 'vitest'

vi.mock('./plan-share.js', async orig => { const m = await orig(); return { ...m, parsePlan: vi.fn(m.parsePlan) } })
vi.mock('./session-start.js', async orig => { const m = await orig(); return { ...m, buildSessionEntries: vi.fn(m.buildSessionEntries) } })

import { parsePlan } from './plan-share.js'
import { buildSessionEntries } from './session-start.js'
import { withinLimits, sharedRoutineOf } from './shared-routines.js'
import { rowPlan, routineRows, buildSets } from './history.js'
import { buildCombinedEntries, fitsSession, sessionRows } from './session-merge.js'
import { MAX_ROUTINE_ROWS } from './limits.js'

const timedPerSide = { id: '0001', mode: 'time', sec: 30, side: true, sets: 50 }
const fifty = { id: '0025', sets: 50, reps: 5, weight: 60 }
const S = { unit: 'kg', routines: [], workouts: [], exWeights: {}, week: {}, dayPlan: {} }

describe('rowPlan counts what the builders build', () => {
  it('a timed per-side set is two rows, as buildSets makes it', () => {
    const cfg = { ...timedPerSide, sets: 3 }
    expect(rowPlan(cfg).rows).toBe(6)
    expect(buildSets(S, cfg)).toHaveLength(6)
  })
  it('counts warm-ups, drops, bursts and a triple progression’s ceiling', () => {
    expect(rowPlan({ id: '0025', sets: 3, warmupSets: 2 }).rows).toBe(5)
    expect(rowPlan({ id: '0025', sets: 3, intensifier: { type: 'dropset', count: 2, pct: 20 } }).rows).toBe(3 + 3 * 2)
    expect(rowPlan({ id: '0025', sets: 3, setsMax: 6, reps: 8 }).work).toBe(6)
    const rp = rowPlan({ id: '0025', sets: 4, reps: 8, intensifier: { type: 'restpause', totalReps: 12, restSec: 15 } })
    expect(rp.rows).toBe(2 + rp.bursts)
  })
})

describe('case 1: ten timed per-side slots at 50 sets', () => {
  const r = { id: 'r9', name: 'Holds', ex: Array.from({ length: 10 }, () => ({ ...timedPerSide })) }
  it('is 1,000 rows, past the cap, though each slot is within its own limits', () => {
    expect(routineRows(r)).toBe(1000)
    expect(withinLimits(r)).toBe(false)
  })
  it('gives no routine, and nothing is copied or built from it', () => {
    parsePlan.mockClear()
    const item = { id: 'sh1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h-holds', routine: r }
    expect(sharedRoutineOf(item, 'kg')).toBeNull()
    expect(parsePlan).not.toHaveBeenCalled()
  })
})

describe('case 2: two combined 500-row routines', () => {
  const a = { id: 'a', name: 'A', ex: Array.from({ length: 10 }, () => ({ ...fifty })) }
  const b = { id: 'b', name: 'B', ex: Array.from({ length: 10 }, () => ({ ...fifty, id: '0007' })) }
  const st = { ...S, routines: [a, b] }
  it('each fits alone', () => {
    expect(routineRows(a)).toBe(MAX_ROUTINE_ROWS)
    expect(fitsSession([a])).toBe(true)
  })
  it('together they are refused before a row is built, not cut down', () => {
    buildSessionEntries.mockClear()
    const out = buildCombinedEntries(st, ['a', 'b'])
    expect(out).toEqual({ entries: [], routineIds: [], routines: [], tooLarge: true })
    expect(buildSessionEntries).not.toHaveBeenCalled()
  })
})

describe('case 3: an addition that crosses the cap', () => {
  const session = [{ id: '0025', sets: Array.from({ length: 400 }, () => ({ w: 60, r: 5, done: false })) }]
  const more = { id: 'm', name: 'More', ex: [{ ...fifty }, { ...fifty, id: '0007' }, { ...fifty, id: '0001' }] }
  it('a 400-row session can’t take a 150-row routine, and can take a 100-row one', () => {
    expect(sessionRows(session)).toBe(400)
    expect(fitsSession([more], session)).toBe(false)
    expect(fitsSession([{ ...more, ex: more.ex.slice(0, 2) }], session)).toBe(true)
  })
  it('counts a session’s per-side halves, drops and bursts like the plan does', () => {
    expect(sessionRows([{ sets: [{ w: 1, r: 1, drops: [{}, {}] }, { sides: { L: { r: 1 }, R: { r: 1 } }, r: 2 }] }])).toBe(3 + 2)
  })
})
