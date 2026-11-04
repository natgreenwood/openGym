// NATG-486: every reader that plans, starts, prompts or reminds goes through the one resolver, so
// a routine shared with you is scheduled and trained like your own (AC4), the finish prompt and
// the Coach never change it (AC5), a workout already running keeps the version it started with
// (AC8), and a share that is not available reads as absent until it heals (AC9).
import { describe, expect, it } from 'vitest'
import { effectiveRoutines, nextTrainingDay } from './history.js'
import { buildCombinedEntries } from './session-merge.js'
import { routineAdditions } from './session-routines.js'
import { applyChangeSet, markStale, CONSENT_VERSION } from './coach.js'
import { buildNudgeNotifications, buildReminderNotifications } from './mobile.js'
import { sharedView } from './shared-routines.js'
import { weekTally } from './queue.js'
import { loadOfWeeklyPlan } from './muscles.js'
import { buildWidgetSnapshot } from './widgets.js'

const ME = { id: 'u2', name: 'Jo' }
const LEG = { id: 'r9', name: 'Leg Day', emoji: 'barbell', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }] }
const accepted = (id, routine = LEG, extra = {}) => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h' + id, routine, ...extra })
const viewOf = (incoming, unit = 'kg') => sharedView({ uid: ME.id, incoming, outgoing: [], etag: 'e' }, ME, unit)
const state = over => ({
  unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0007', sets: 3, reps: 10 }] }], week: {}, dayPlan: {}, workouts: [],
  exWeights: {}, bodyweight: [], customEx: [], queue: null, ...over,
})
// 2026-11-02 is a Monday.
const MON = '2026-11-02', TUE = '2026-11-03'

describe('shared weekdays beside a coach queue', () => {
  const coach = ['d1', 'd2', 'd3'].map(id => ({ id, name: id, ex: [{ id: '0025', sets: 2, reps: 5 }] }))
  const own = { id: 'own', name: 'Own press', ex: [{ id: '0025', sets: 3, reps: 5 }] }
  const plan = () => state({
    routines: [...coach, own],
    queue: { ids: ['d1', 'd2', 'd3'], since: Date.parse(MON + 'T08:00:00'), startsOn: MON, label: 'Coach week' },
    week: { 1: ['d1'], 3: ['d2', 'own', 'shared:s1'], 5: ['d3', 'shared:s1'] },
    workouts: [{ id: 'merged', d: MON, start: Date.parse(MON + 'T09:00:00'), routineIds: ['d1', 'shared:s1'], name: 'd1 + Shared press', entries: [] }],
  })

  it('counts each queue session once and mixed weekdays once, preserving merged completion credit', () => {
    const S = plan(), shared = viewOf([accepted('s1')])
    expect(weekTally(S, TUE, shared)).toEqual({ done: 2, planned: 5 })
    // Three coach sessions at two sets, one own day at three, and two shared days at five.
    expect(loadOfWeeklyPlan(S, shared).chest).toBe(19)
    expect(buildWidgetSnapshot(S, { today: TUE, shared }).week).toEqual({ done: 2, planned: 5 })
  })

  it('removes revoked or unavailable volume while retaining the own weekday and completed credit', () => {
    const S = plan()
    for (const shared of [viewOf([]), viewOf([accepted('s1', LEG, { unavailable: 'custom-exercise' })])]) {
      expect(weekTally(S, TUE, shared)).toEqual({ done: 2, planned: 4 })
      expect(loadOfWeeklyPlan(S, shared).chest).toBe(9)
      expect(buildWidgetSnapshot(S, { today: TUE, shared }).week).toEqual({ done: 2, planned: 4 })
    }
  })

  it('keeps a future coach queue out of the tally until its start, while counting shared weekdays', () => {
    const S = plan(), shared = viewOf([accepted('s1')])
    S.queue.startsOn = '2026-11-09'
    expect(weekTally(S, TUE, shared)).toEqual({ done: 1, planned: 3 })
    expect(buildWidgetSnapshot(S, { today: TUE, shared }).week).toEqual({ done: 1, planned: 3 })
  })
})

describe('the schedule plans a shared routine like your own (AC4)', () => {
  const S = state({ week: { 1: ['shared:s1'], 2: ['r1', 'shared:s1'] } })
  it('makes a day whose only routine is shared a training day', () => {
    const shared = viewOf([accepted('s1')])
    expect(effectiveRoutines(S, MON, shared, MON).map(r => r.name)).toEqual(['Leg Day'])
    expect(effectiveRoutines(S, TUE, shared, MON).map(r => r.name)).toEqual(['Push', 'Leg Day'])
  })
  it('reads that day as rest without the shared routines, the way it always did', () => {
    expect(effectiveRoutines(S, MON, null, MON)).toEqual([])
  })
  it('reads it as rest while the share is not available, and as before once it heals (AC9)', () => {
    const off = viewOf([{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unavailable: 'custom-exercise' }])
    expect(effectiveRoutines(S, MON, off, MON)).toEqual([])
    expect(S.week[1]).toEqual(['shared:s1'])   // the pointer stays where it was
    expect(effectiveRoutines(S, MON, viewOf([accepted('s1')]), MON).map(r => r.name)).toEqual(['Leg Day'])
  })
  it('never plans a pending share', () => {
    const pending = viewOf([{ id: 's1', state: 'pending', from: { id: 'u1', name: 'Sam' }, preview: { name: 'Leg Day', exercises: 1 } }])
    expect(effectiveRoutines(S, MON, pending, MON)).toEqual([])
  })
  it('finds the next training day through a shared routine', () => {
    const only = state({ routines: [], week: { 3: ['shared:s1'] } })
    expect(nextTrainingDay(only, MON, viewOf([accepted('s1')]))).toMatchObject({ iso: '2026-11-04' })
    expect(nextTrainingDay(only, MON, null)).toBeNull()
  })
})

describe('starting a workout from a shared routine (AC4, AC8)', () => {
  it('builds its entries from the version this device holds, each stamped with the pointer', () => {
    const S = state()
    const { entries, routineIds, routines } = buildCombinedEntries(S, ['shared:s1', 'r1'], viewOf([accepted('s1')]))
    expect(routineIds).toEqual(['shared:s1', 'r1'])
    expect(routines.map(r => r.name)).toEqual(['Leg Day', 'Push'])
    expect(entries.map(e => [e.id, e.rid])).toEqual([['0025', 'shared:s1'], ['0007', 'r1']])
  })
  it('keeps the version it started with when the sharer’s edit arrives mid-workout', () => {
    const S = state()
    const before = buildCombinedEntries(S, ['shared:s1'], viewOf([accepted('s1')]))
    const active = { routineIds: before.routineIds, entries: structuredClone(before.entries) }
    const snapshot = JSON.stringify(active)
    // The sharer adds an exercise; the next sync brings it.
    const edited = viewOf([accepted('s1', { ...LEG, ex: [...LEG.ex, { id: '0007', sets: 3, reps: 8 }] }, { hash: 'h-new' })])
    expect(JSON.stringify(active)).toBe(snapshot)
    // The next start has it.
    expect(buildCombinedEntries(S, ['shared:s1'], edited).entries.map(e => e.id)).toEqual(['0025', '0007'])
  })
  it('starts nothing from a share that is not available', () => {
    const off = viewOf([{ id: 's1', state: 'accepted', unavailable: 'custom-exercise' }])
    expect(buildCombinedEntries(state(), ['shared:s1'], off).entries).toEqual([])
  })
})

describe('a shared routine is never changed from the recipient’s side (AC5)', () => {
  it('the finish summary offers no “add it to the routine” for a shared one', () => {
    const shared = viewOf([accepted('s1')])
    const routines = [...state().routines, ...shared.routines]
    const active = { entries: [
      { id: '0009', rid: 'shared:s1', addedInSession: true, sets: [{ w: 20, r: 8, done: true }] },
      { id: '0009', rid: 'r1', addedInSession: true, sets: [{ w: 20, r: 8, done: true }] },
    ] }
    expect(routineAdditions(active, routines).map(a => a.routineId)).toEqual(['r1'])
  })
  it('the Coach finds no shared routine: a change naming one is stale, and applying it fails', () => {
    const S = state({ coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION }, log: [], snapshots: [] } })
    const p = { id: 'p1', kind: 'review', summary: 's', changes: [
      { id: 'c1', type: 'rename-routine', target: { routineId: 'shared:s1' }, before: 'Leg Day', after: 'Mine now', why: 'x' },
      { id: 'c2', type: 'remove-routine', target: { routineId: 'shared:s1' }, why: 'x' },
    ] }
    expect(markStale(p, { ...S, week: { 1: ['shared:s1'] } }).changes.map(c => c.status)).toEqual(['stale', 'stale'])
    const draft = structuredClone({ ...S, week: { 1: ['shared:s1'] } })
    expect(() => applyChangeSet(draft, { ...p, changes: [p.changes[1]] }, ['c2'])).toThrow()
  })
})

describe('the phone’s reminders and nudges count shared routines', () => {
  const now = new Date(2026, 10, 2, 7, 0)   // Monday 07:00
  const S = state({ routines: [], week: { 1: ['shared:s1'] }, reminder: { on: true, time: '08:00', nudge: true }, workouts: [{ d: '2026-10-30', id: 'w', entries: [] }] })
  it('reminds of a day whose only routine is shared, by its name', () => {
    const n = buildReminderNotifications(S, now, viewOf([accepted('s1')]))
    expect(n[0].body).toContain('Leg Day')
    expect(buildReminderNotifications(S, now, null)).toEqual([])
  })
  it('nudges about it, and not about a share that is not available', () => {
    expect(buildNudgeNotifications(S, now, viewOf([accepted('s1')]))[0].body).toContain('Leg Day')
    expect(buildNudgeNotifications(S, now, viewOf([{ id: 's1', state: 'accepted', unavailable: 'custom-exercise' }]))).toEqual([])
  })
})

describe('the streak card, the weekly volume and the widget plan a shared day like your own (NATG-498)', () => {
  // Monday shared only, Tuesday combined, Thursday a share that is not available, Friday one that ended.
  const S = state({ week: { 1: ['shared:s1'], 2: ['r1', 'shared:s1'], 4: ['shared:s2'], 5: ['shared:s3'] } })
  const shared = viewOf([accepted('s1'), { id: 's2', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unavailable: 'custom-exercise' }])
  it('counts the days whose shared routines resolve, a combined day once (AC1)', () => {
    expect(weekTally(S, TUE, shared)).toEqual({ done: 0, planned: 2 })
    expect(weekTally(S, TUE, null)).toEqual({ done: 0, planned: 1 })
  })
  it('keeps counting a finished shared workout as done, as it always did (AC1)', () => {
    const done = { ...S, workouts: [{ id: 'w', d: MON, start: Date.parse(MON + 'T18:00:00'), routineIds: ['shared:s1'], name: 'Leg Day', entries: [] }] }
    expect(weekTally(done, TUE, shared)).toEqual({ done: 1, planned: 2 })
    expect(weekTally(done, TUE, null)).toEqual({ done: 1, planned: 1 })
  })
  it('adds the shared routine’s sets on every weekday it is planned (AC2)', () => {
    const asOwn = state({ routines: [state().routines[0], { ...LEG, id: 'r9' }], week: { 1: ['r9'], 2: ['r1', 'r9'] } })
    expect(loadOfWeeklyPlan(S, shared)).toEqual(loadOfWeeklyPlan(asOwn))
    expect(Object.keys(loadOfWeeklyPlan(S, shared)).length).toBeGreaterThan(Object.keys(loadOfWeeklyPlan(S)).length)
  })
  it('gives a plan of shared routines only a weekly volume and a fraction (AC2, AC3)', () => {
    const only = state({ routines: [], week: { 3: ['shared:s1'] } })
    expect(Object.keys(loadOfWeeklyPlan(only, shared)).length).toBeGreaterThan(0)
    expect(loadOfWeeklyPlan(only)).toEqual({})
    expect(weekTally(only, TUE, shared)).toEqual({ done: 0, planned: 1 })
  })
  it('gives the home-screen widget the same fraction as the Home streak card (AC4)', () => {
    expect(buildWidgetSnapshot(S, { today: TUE, shared }).week).toEqual(weekTally(S, TUE, shared))
    expect(buildWidgetSnapshot(S, { today: TUE }).week).toEqual({ done: 0, planned: 1 })
  })
})
