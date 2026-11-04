// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The iPhone widgets' snapshot (lib/widgets.js): what the page hands the widget extension through
// the App Group. The shape is what ios/App/OpenGymWidgets/WidgetSnapshot.swift decodes, so a field
// renamed here is a widget gone blank there. Text only, nothing from the exercise media.
const h = vi.hoisted(() => { vi.stubEnv('VITE_MOBILE', '1'); return { platform: 'ios' } })
vi.mock('./mobile.js', () => ({ MOBILE: true, nativePlatform: async () => h.platform }))

const { buildWidgetSnapshot, startWidgetSync, _setWidgetPluginForTest, _resetWidgets, WIDGET_DAYS } = await import('./widgets.js')
const { sharedViewOf } = await import('./shared-routines.js')
const { MAX_WIDGET_TEXT } = await import('./limits.js')

// 2026-10-14 is a Wednesday (getDay 3).
const TODAY = '2026-10-14'
const push = { id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }, { id: 'c1', name: 'Cable thing', sets: 2, reps: 12 }] }
const legs = { id: 'r2', name: 'Legs', ex: [{ id: '0043', sets: 5, reps: 5, weight: 100 }] }
const S = (over = {}) => ({
  unit: 'kg', accent: 'sky', routines: [push, legs], week: { 3: ['r1'], 5: ['r2'] }, dayPlan: {}, workouts: [], bodyweight: [], ...over,
})

describe('buildWidgetSnapshot', () => {
  it('has the plan for today and the week after it, today with its exercises', () => {
    const snap = buildWidgetSnapshot(S(), { today: TODAY })
    expect(snap.v).toBe(1)
    expect(snap.today).toBe(TODAY)
    expect(snap.days).toHaveLength(WIDGET_DAYS)
    expect(snap.days.map(d => d.iso)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'])
    const [today, thu, fri] = snap.days
    expect(today).toMatchObject({ name: 'Push', count: 2, done: false })
    expect(today.exercises).toHaveLength(2)
    expect(today.exercises[0].line).toMatch(/3 × 8 · 60 kg/)
    expect(today.exercises[1].name).toBe('Cable thing')
    // Title-cased like the app shows it, not the stored lower-case name.
    expect(today.exercises[0].name).toBe('Barbell Bench Press')
    expect(typeof today.weekday).toBe('string')
    // A rest day is a day without a name; other days carry no exercise list.
    expect(thu).toMatchObject({ name: null, count: 0 })
    expect(fri).toMatchObject({ name: 'Legs', count: 1 })
    expect(fri.exercises).toBeUndefined()
    // the next week's Wednesday again
    expect(snap.days[7].name).toBe('Push')
  })

  it('says today is done once a workout from today covers it', () => {
    const w = { id: 'w1', d: TODAY, start: 1, end: 2, routineIds: ['r1'], entries: [] }
    expect(buildWidgetSnapshot(S({ workouts: [w] }), { today: TODAY }).days[0].done).toBe(true)
    const other = { ...w, routineIds: ['r2'] }
    expect(buildWidgetSnapshot(S({ workouts: [other] }), { today: TODAY }).days[0].done).toBe(false)
  })

  it('counts the week, the streak and names the last PR with its best weight', () => {
    const older = { id: 'w0', d: '2026-10-01', end: 1, prs: ['0043'], entries: [{ id: '0043', target: { mode: 'reps' }, sets: [{ w: 90, r: 5, done: true }] }] }
    const newer = { id: 'w1', d: '2026-10-13', end: 5, prs: ['0025'], entries: [{ id: '0025', target: { mode: 'reps' }, sets: [{ w: 62.5, r: 8, done: true }, { w: 65, r: 6, done: true }] }] }
    const snap = buildWidgetSnapshot(S({ workouts: [newer, older] }), { today: TODAY })
    expect(snap.week).toEqual({ done: 1, planned: 2 })
    expect(snap.weekFrom).toBe('2026-10-12')
    expect(snap.weekUntil).toBe('2026-10-19')
    expect(typeof snap.streak).toBe('number')
    expect(snap.lastPR).toMatchObject({ value: '65 kg', d: '2026-10-13' })
    expect(snap.lastPR.name).toBeTruthy()
    expect(buildWidgetSnapshot(S(), { today: TODAY }).lastPR).toBeNull()
  })

  it('shows a running workout, but not a saved one being edited', () => {
    const active = { id: 'a1', name: 'Push', start: 1000, entries: [{ id: '0025', sets: [{ done: true }, { done: false }, { done: false }] }] }
    expect(buildWidgetSnapshot(S({ active }), { today: TODAY }).active).toEqual({ id: 'a1', name: 'Push', start: 1000, done: 1, total: 3 })
    expect(buildWidgetSnapshot(S({ active: { ...active, editingWorkoutId: 'w9' } }), { today: TODAY }).active).toBeNull()
    expect(buildWidgetSnapshot(S(), { today: TODAY }).active).toBeNull()
  })

  it('carries the accent and its words, and stands up to a thin state', () => {
    const snap = buildWidgetSnapshot(S(), { today: TODAY })
    expect(snap.accent).toBe('#0a84ff')
    expect(snap.ink).toBe('#ffffff')
    expect(buildWidgetSnapshot(S({ accent: 'custom', accentCustom: '#123456' }), { today: TODAY }).accent).toBe('#123456')
    for (const k of ['today', 'restDay', 'upNext', 'thisWeek', 'weekStreak', 'streak', 'lastPR', 'done', 'running']) {
      expect(typeof snap.labels[k], k).toBe('string')
    }
    const thin = buildWidgetSnapshot({}, { today: TODAY })
    expect(thin.days.every(d => d.name === null)).toBe(true)
    expect(thin.week).toEqual({ done: 0, planned: 0 })
    // plain JSON all the way down
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })

  // A day planned only with a routine shared with you (NATG-526): the day list shows it as the
  // Home today row does, and agrees with the widget's own week fraction (NATG-498).
  describe('a day planned with a shared routine', () => {
    const user = { id: 'u2', name: 'Jo' }
    const shares = { uid: 'u2', etag: 'e', outgoing: [], incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h', routine: { ...legs, name: 'Sam legs' } }] }
    const shared = sharedViewOf({ S: { unit: 'kg' }, user, shares })
    // Wednesday (today) and next Wednesday hold only the shared routine.
    const sharedOnly = (over = {}) => S({ routines: [], week: { 3: ['shared:s1'] }, ...over })

    it('shows the shared routine with its name, count and today\'s exercises', () => {
      const snap = buildWidgetSnapshot(sharedOnly(), { today: TODAY, shared })
      const [today] = snap.days
      expect(today).toMatchObject({ name: 'Sam legs', count: 1, done: false })
      expect(today.exercises).toHaveLength(1)
      expect(today.exercises[0].line).toMatch(/5 × 5 · 100 kg/)
      expect(snap.days[7]).toMatchObject({ name: 'Sam legs', count: 1 })
      expect(snap.days[7].exercises).toBeUndefined()
      // the list and the week's fraction count the same days
      expect(snap.week.planned).toBe(1)
      expect(snap.days.filter(d => d.name && d.iso < snap.weekUntil).length).toBe(snap.week.planned)
    })

    it('says today is done once a workout from today covers the shared routine, not before', () => {
      const w = { id: 'w1', d: TODAY, start: 1, end: 2, routineIds: ['shared:s1'], entries: [] }
      expect(buildWidgetSnapshot(sharedOnly({ workouts: [w] }), { today: TODAY, shared }).days[0].done).toBe(true)
      expect(buildWidgetSnapshot(sharedOnly(), { today: TODAY, shared }).days[0].done).toBe(false)
      const own = { ...w, routineIds: ['r2'] }
      expect(buildWidgetSnapshot(sharedOnly({ workouts: [own] }), { today: TODAY, shared }).days[0].done).toBe(false)
      const yesterday = { ...w, d: '2026-10-13' }
      expect(buildWidgetSnapshot(sharedOnly({ workouts: [yesterday] }), { today: TODAY, shared }).days[0].done).toBe(false)
    })

    it('without the shared routines, reads as it always did', () => {
      const rest = buildWidgetSnapshot(sharedOnly(), { today: TODAY })
      expect(rest.days[0]).toEqual({ iso: TODAY, weekday: rest.days[0].weekday, name: null, count: 0 })
      expect(rest.week).toEqual({ done: 0, planned: 0 })
      // a plan of your own comes out the same with or without the argument
      expect(buildWidgetSnapshot(S(), { today: TODAY, shared: null })).toEqual(buildWidgetSnapshot(S(), { today: TODAY }))
      expect(buildWidgetSnapshot(S(), { today: TODAY, shared }).days).toEqual(buildWidgetSnapshot(S(), { today: TODAY }).days)
    })
  })

  // Every text field is cut to MAX_WIDGET_TEXT code points, so a sharer's name can't make the
  // snapshot the widget extension reads into memory as big as they like (SEC-526-01).
  describe('text from routine data is bounded', () => {
    const HUGE = 'x'.repeat(1 << 20) // 1 MiB
    // Catalogue exercises only: a shared routine with a custom exercise is not available at all.
    const routineNamed = name => ({ id: 'r9', name, ex: [legs.ex[0], push.ex[0]] })
    // Its own hash per routine: the shared view keeps a routine it has already checked by hash.
    const viewOf = routine => sharedViewOf({ S: { unit: 'kg' }, user: { id: 'u2', name: 'Jo' }, shares: { uid: 'u2', etag: 'e', outgoing: [], incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: `h-${routine.name.length}`, routine }] } })
    const everyDay = { 0: ['shared:s1'], 1: ['shared:s1'], 2: ['shared:s1'], 3: ['shared:s1'], 4: ['shared:s1'], 5: ['shared:s1'], 6: ['shared:s1'] }
    const snapOf = (name, over = {}) => buildWidgetSnapshot(S({ routines: [], week: everyDay, ...over }), { today: TODAY, shared: viewOf(routineNamed(name)) })
    const logged = { id: 'w1', d: TODAY, start: 1, end: 2, routineIds: ['shared:s1'], entries: [] }

    it('cuts a 1 MiB shared routine name on all eight days, and changes nothing else', () => {
      for (const workouts of [[], [logged]]) {
        const big = snapOf(HUGE, { workouts })
        const small = snapOf('Short', { workouts })
        expect(big.days).toHaveLength(WIDGET_DAYS)
        for (const d of big.days) {
          expect(d.name.length).toBeLessThanOrEqual(MAX_WIDGET_TEXT)
          expect(d.name).toBe(HUGE.slice(0, MAX_WIDGET_TEXT))
        }
        // counts, today's lines and done are as they are with a short name
        expect(big.days.map(d => d.count)).toEqual(small.days.map(d => d.count))
        expect(big.days.map(d => d.count)).toEqual(Array(WIDGET_DAYS).fill(2))
        expect(big.days[0].exercises.map(e => e.line)).toEqual(small.days[0].exercises.map(e => e.line))
        expect(big.days[0].exercises).toEqual(small.days[0].exercises)
        expect(big.days[0].done).toBe(workouts.length > 0)
        expect(big.days[0].done).toBe(small.days[0].done)
        expect(big.week).toEqual(small.week)
        // the whole snapshot stays small
        expect(JSON.stringify(big).length).toBeLessThan(20000)
      }
    })

    it('cuts an own routine\'s custom exercise name, a running session\'s name and the last PR\'s', () => {
      const own = { id: 'r9', name: 'Mine', ex: [{ id: 'c9', name: HUGE, sets: 2, reps: 10 }] }
      const [today] = buildWidgetSnapshot(S({ routines: [own], week: { 3: ['r9'] } }), { today: TODAY }).days
      expect(today.exercises).toEqual([{ name: HUGE.slice(0, MAX_WIDGET_TEXT), line: '2 × 10' }])
      const active = { id: 'a1', name: HUGE, start: 1000, entries: [{ id: 'c9', sets: [{ done: true }] }] }
      const pr = { id: 'w2', d: '2026-10-13', end: 5, prs: ['c9'], entries: [{ id: 'c9', name: HUGE, target: { mode: 'reps' }, sets: [{ w: 40, r: 10, done: true }] }] }
      const snap = buildWidgetSnapshot(S({ active, workouts: [pr] }), { today: TODAY })
      expect(snap.active).toEqual({ id: 'a1', name: HUGE.slice(0, MAX_WIDGET_TEXT), start: 1000, done: 1, total: 1 })
      expect(snap.lastPR).toEqual({ name: HUGE.slice(0, MAX_WIDGET_TEXT), value: '40 kg', d: '2026-10-13' })
    })

    it('counts code points, so an emoji at the cut is kept or dropped whole', () => {
      const nameOf = name => buildWidgetSnapshot(S({ routines: [{ ...push, name }] }), { today: TODAY }).days[0].name
      const a = n => 'a'.repeat(n)
      // the 200th code point is the emoji: kept whole (201 UTF-16 units)
      expect(nameOf(a(199) + '💪' + 'tail')).toBe(a(199) + '💪')
      // the emoji would be the 201st: dropped whole, not half of it
      expect(nameOf(a(200) + '💪')).toBe(a(200))
      // all emoji: 200 of them
      expect(nameOf('💪'.repeat(300))).toBe('💪'.repeat(200))
      // short names are untouched
      expect(nameOf('Push 💪')).toBe('Push 💪')
      for (const name of [a(199) + '💪💪', a(200) + '💪', '💪'.repeat(300)]) {
        const cut = nameOf(name)
        expect([...cut].length).toBeLessThanOrEqual(MAX_WIDGET_TEXT)
        expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      }
    })
  })
})

describe('startWidgetSync', () => {
  let state, subs, writes
  const useStore = {
    getState: () => ({ S: state }),
    subscribe: fn => { subs.push(fn); return () => {} },
  }
  beforeEach(() => {
    vi.useFakeTimers()
    state = S(); subs = []; writes = []
    _setWidgetPluginForTest({ write: async ({ json }) => { writes.push(JSON.parse(json)) } })
  })
  afterEach(() => { vi.useRealTimers(); _resetWidgets() })

  it('writes at start, then only when what the widgets show changed', async () => {
    const stop = await startWidgetSync({ useStore })
    await vi.runAllTimersAsync()
    expect(writes).toHaveLength(1)
    // a change to the state that leaves the snapshot as it was writes nothing
    const prev = state; state = { ...state }
    subs.forEach(fn => fn({ S: state }, { S: prev }))
    await vi.runAllTimersAsync()
    expect(writes).toHaveLength(1)
    const before = state; state = { ...state, routines: [{ ...push, name: 'Push heavy' }, legs] }
    subs.forEach(fn => fn({ S: state }, { S: before }))
    await vi.runAllTimersAsync()
    expect(writes).toHaveLength(2)
    expect(writes[1].days.some(d => d.name === 'Push heavy')).toBe(true)
    stop()
  })

  it('counts a day planned with a shared routine once the shared routines arrive (NATG-498)', async () => {
    let store = { S: S({ routines: [], week: { 3: ['shared:s1'] } }), user: null, shares: null }
    const stub = { getState: () => store, subscribe: fn => { subs.push(fn); return () => {} } }
    const stop = await startWidgetSync({ useStore: stub })
    await vi.runAllTimersAsync()
    expect(writes.at(-1).week).toEqual({ done: 0, planned: 0 })
    const user = { id: 'u2', name: 'Jo' }
    const shares = { uid: 'u2', etag: 'e', outgoing: [], incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h', routine: legs }] }
    const prev = store; store = { ...store, user, shares }
    subs.forEach(fn => fn(store, prev))
    await vi.runAllTimersAsync()
    expect(writes.at(-1).week).toEqual({ done: 0, planned: 1 })
    stop()
  })

  it('does nothing off the iPhone app', async () => {
    _resetWidgets()
    h.platform = 'android'
    const stop = await startWidgetSync({ useStore })
    await vi.runAllTimersAsync()
    expect(writes).toEqual([])
    stop()
    h.platform = 'ios'
  })
})
