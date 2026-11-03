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

// SEC-486-01, counted from what was built: sessionRows reads a built session the way rowPlan
// reads its plan, so the budget's two sides agree. A per-side row is its two sides, each with its
// own drops or bursts; the parent row is their aggregate and isn't counted as well.
describe('sessionRows of the built entries is rowPlan’s rows', () => {
  const lift = { id: '0025', sets: 3, reps: 8, weight: 60 }
  const drops = n => ({ type: 'dropset', count: n, pct: 20 })
  const restPause = total => ({ type: 'restpause', totalReps: total, restSec: 15 })
  const built = cfg => buildSessionEntries(S, { id: 'r', name: 'R', ex: [cfg] })
  it.each([
    ['plain', lift],
    ['per-side', { ...lift, side: true }],
    ['timed per-side', { id: '0001', mode: 'time', sec: 30, side: true, sets: 3 }],
    ['drop-set', { ...lift, intensifier: drops(2) }],
    ['per-side drop-set', { ...lift, side: true, intensifier: drops(3) }],
    ['per-side drop-set at the limits', { ...lift, side: true, sets: 20, intensifier: drops(10) }],
    ['rest-pause', { ...lift, intensifier: restPause(20) }],
    ['per-side rest-pause, an odd total (uneven side extras)', { ...lift, side: true, intensifier: restPause(15) }],
    ['per-side rest-pause of one rep (one side has none)', { ...lift, side: true, intensifier: restPause(1) }],
    ['warm-ups', { ...lift, warmupSets: 2 }],
    ['warm-ups and a drop-set', { ...lift, warmupSets: 2, intensifier: drops(2) }],
    ['per-side warm-ups', { ...lift, side: true, warmupSets: 3 }],
    ['pyramid', { ...lift, sets: 4, pyramid: [12, 10, 8, 'Max'] }],
  ])('%s', (_, cfg) => {
    expect(sessionRows(built(cfg))).toBe(rowPlan(cfg).rows)
  })
  it('per-side rest-pause with an odd total really is uneven: each side bursts its own half', () => {
    const [entry] = built({ ...lift, side: true, intensifier: restPause(15) })
    const work = entry.sets.find(s => s.type === 'restpause')
    expect(work.sides.L.clusters.length).not.toBe(work.sides.R.clusters.length)
  })
  it('triple progression: never more than rowPlan’s rows, and exactly them once it opens at its ceiling', () => {
    const cfg = { ...lift, sets: 3, setsMax: 5, reps: 10, repsMin: 8, prog: 'triple' }
    const routine = { id: 'r', name: 'R', ex: [cfg] }
    let st = { ...S, routines: [routine] }
    const seen = []
    for (let day = 1; day <= 30 && !seen.includes(5); day++) {
      const [entry] = buildSessionEntries(st, routine)
      const rows = sessionRows([entry])
      expect(rows).toBeLessThanOrEqual(rowPlan(cfg).rows)
      seen.push(rows)
      // Every set lifted as asked, then saved: the cycle climbs to its ceiling.
      const sets = entry.sets.map(s => ({ ...s, done: true }))
      st = { ...st, workouts: [...st.workouts, { d: `2026-01-${String(day).padStart(2, '0')}`, routineId: 'r', entries: [{ ...entry, rid: 'r', sets }] }] }
    }
    expect(seen[0]).toBe(3)
    expect(seen.at(-1)).toBe(rowPlan(cfg).rows)
  })
  it('counts each side’s own extras when they differ: a drop taken off one side, bursts added to the other', () => {
    const cfg = { ...lift, side: true, intensifier: drops(3) }
    const entries = built(cfg)
    const set = entries[0].sets[0]
    set.sides.L.drops.pop()
    set.sides.R.drops.push({ w: 10, r: 8 }, { w: 8, r: 8 })
    expect(sessionRows(entries)).toBe(rowPlan(cfg).rows - 1 + 2)
  })
  it('does not count a per-side row’s parent as a row of its own, nor drops left on it', () => {
    const side = { r: 4, drops: [{}, {}] }
    expect(sessionRows([{ sets: [{ sides: { L: side, R: { r: 4 } }, r: 8, drops: [{}, {}, {}] }] }])).toBe(2 + 2)
  })
})

describe('an addition that crosses the cap because of per-side extras', () => {
  // 20 per-side sets with 10 drops each: 2 × (20 + 200) = 440 rows, built. Counting the parent row
  // only (the earlier undercount) made it 40.
  const unilateral = { id: 'u', name: 'Unilateral', ex: [{ id: '0025', side: true, sets: 20, reps: 8, weight: 60, intensifier: { type: 'dropset', count: 10, pct: 10 } }] }
  const hundred = { id: 'h', name: 'Hundred', ex: [{ id: '0007', sets: 50, reps: 5 }, { id: '0001', sets: 50, reps: 5 }] }
  const sixty = { id: 'x', name: 'Sixty', ex: [{ id: '0007', sets: 50, reps: 5 }, { id: '0001', sets: 10, reps: 5 }] }
  const st = { ...S, routines: [unilateral, hundred, sixty] }
  it('a 440-row per-side session can’t take 100 rows more, and can take 60', () => {
    const { entries } = buildCombinedEntries(st, ['u'])
    expect(sessionRows(entries)).toBe(440)
    expect(fitsSession([hundred], entries)).toBe(false)
    expect(fitsSession([sixty], entries)).toBe(true)
  })
})
