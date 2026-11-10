// @vitest-environment happy-dom
// The Apple Watch link, the page's side: the snapshot the watch runs a session from, and the
// watch's events applied once each through the workout screen's own actions, drained from the
// native queue and acknowledged only when done.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSnapshot, buildReady, fitSnapshot, applyEvents, bindWatchActions, bindWatchAppActions, drainWatchEvents, _setWatchPluginForTest, _resetWatchSync, SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES } from './watch-sync.js'
import { buildCombinedEntries, deriveSessionName } from './session-merge.js'
import { sharedViewOf } from './shared-routines.js'
import { MAX_WIDGET_TEXT } from './limits.js'

const state = (over = {}) => ({
  unit: 'kg', restSec: 90, workouts: [], routines: [],
  active: {
    id: 'w-1', name: 'Push day', cur: 1, d: '2026-10-13',
    entries: [
      { id: '0025', target: { sets: 2, reps: 8, weight: 60 }, sets: [{ w: 60, r: 8, done: true }, { w: 60, r: 8, done: false }] },
      { id: '0001', target: { sets: 1, reps: 10, restSec: 120 }, sets: [{ w: 20, r: 10, done: false, phase: 'warmup' }] },
    ],
  },
  ...over,
})

beforeEach(() => { localStorage.clear(); _resetWatchSync() })
afterEach(() => _resetWatchSync())

describe('the snapshot', () => {
  it('carries what the watch needs to run the session, and nothing else', () => {
    const snap = buildSnapshot(state(), { timer: { endsAt: 1760000000000 } })
    expect(snap.v).toBe(SNAPSHOT_VERSION)
    expect(snap.active).toMatchObject({ id: 'w-1', name: 'Push day', unit: 'kg', cur: 1, restSec: 90, rest: { endsAt: 1760000000000 } })
    expect(snap.active.entries).toHaveLength(2)
    const [a, b] = snap.active.entries
    expect(a).toMatchObject({ id: '0025', mode: 'reps', restSec: null, last: null })
    // Title-cased like the phone shows it, not the stored lower-case name.
    expect(a.name).toBe('Barbell Bench Press')
    expect(a.sets).toEqual([{ w: 60, r: 8, sec: null, done: true, warmup: false }, { w: 60, r: 8, sec: null, done: false, warmup: false }])
    expect(b.restSec).toBe(120)
    expect(b.sets[0].warmup).toBe(true)
    // plain data only: no media, no image or animation paths
    expect(JSON.stringify(snap)).not.toMatch(/\.(gif|webp|png|jpg|mp4)|media|img/i)
  })

  it('says there is no workout when none runs, and no rest when it is paused or over', () => {
    expect(buildSnapshot({ unit: 'kg' })).toEqual({ v: SNAPSHOT_VERSION, unit: 'kg', restSec: 0, active: null, ready: null })
    expect(buildSnapshot(state(), { timer: { endsAt: 5, paused: true } }).active.rest).toBeNull()
    expect(buildSnapshot(state(), { timer: { endsAt: 5, ready: true } }).active.rest).toBeNull()
    expect(buildSnapshot(state({ unit: 'lb' })).active.unit).toBe('lb')
  })

  it('names the last time of an exercise when the history has one', () => {
    const S = state({ workouts: [{ id: 'old', d: '2026-10-01', entries: [{ id: '0025', target: { sets: 2, reps: 8 }, sets: [{ w: 55, r: 8, done: true }, { w: 55, r: 7, done: true }] }] }] })
    expect(buildSnapshot(S).active.entries[0].last).toMatch(/55/)
  })
})

// Every name that comes from routine data is cut to MAX_WIDGET_TEXT code points, so a sharer's
// routine name can't push the snapshot over the app-context limit, which would leave the watch
// never hearing of the workout (NATG-553, the watch side of SEC-526-01).
describe('text from routine data is bounded', () => {
  const HUGE = 'x'.repeat(1 << 20) // 1 MiB
  const CUT = HUGE.slice(0, MAX_WIDGET_TEXT)
  const bytesOf = v => new TextEncoder().encode(JSON.stringify(v)).length
  // Catalogue exercises only: a shared routine with a custom exercise is not available at all.
  const sharedNamed = name => ({ id: 'r9', name, ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }, { id: '0001', sets: 2, reps: 10 }] })
  // A new hash per view: the shared view keeps a routine it has already checked by hash, and two
  // routines here can share a name but not their slots.
  let views = 0
  const viewOf = routine => sharedViewOf({ S: { unit: 'kg' }, user: { id: 'u2', name: 'Jo' }, shares: { uid: 'u2', etag: 'e', outgoing: [], incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: `h-${++views}`, routine }] } })
  // A session started from the shared routine the way sheets.jsx beginWorkout starts one.
  const startedFrom = (name, ids = ['shared:s1'], over = {}) => {
    const S = { unit: 'kg', restSec: 90, workouts: [], routines: [], week: {}, dayPlan: {}, ...over }
    const { entries, routineIds, routines } = buildCombinedEntries(S, ids, viewOf(sharedNamed(name)))
    expect(routines.length).toBe(ids.length)
    return { ...S, active: { id: 'w-9', start: 1000, routineIds, name: deriveSessionName(routines.map(r => r.name)), cur: 0, entries } }
  }

  it('cuts a running session named from a 1 MiB shared routine name, and keeps the workout whole', () => {
    const big = buildSnapshot(startedFrom(HUGE))
    const small = buildSnapshot(startedFrom('Short'))
    expect(big.active.name).toBe(CUT)
    // everything else is as it is with a short name
    expect({ ...big.active, name: 'Short' }).toEqual(small.active)
    expect(big.active.entries).toHaveLength(2)
    expect(big.active.entries[0].sets).toHaveLength(3)
    // within what the watch accepts, so fitSnapshot has nothing to drop
    expect(bytesOf(big)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(fitSnapshot(big)).toBe(big)
  })

  it('cuts the joined name of a session from a shared routine and your own', () => {
    const own = { id: 'r-own', name: HUGE, ex: [{ id: '0043', sets: 5, reps: 5, weight: 100 }] }
    const snap = buildSnapshot(startedFrom(HUGE, ['shared:s1', 'r-own'], { routines: [own] }))
    expect(snap.active.name).toBe(CUT)
    expect(snap.active.entries.map(e => e.id)).toEqual(['0025', '0001', '0043'])
    expect(bytesOf(snap)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  })

  it('cuts the names of what the watch can start, and a custom exercise\'s name', () => {
    const routines = [
      { id: 'r-a', name: HUGE, ex: [{ id: 'c9', name: HUGE, sets: 2, reps: 10 }] },
      { id: 'r-b', name: 'B' + HUGE, ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
      { id: 'r-c', name: 'Pull', ex: [{ id: '0001', sets: 2, reps: 10 }] },
    ]
    // Tuesday's plan is two routines, so today's name is two huge names joined
    const S = { unit: 'kg', workouts: [], routines, week: { 2: ['r-a', 'r-b'] }, dayPlan: {} }
    const ready = buildReady(S, '2026-10-13')
    expect(ready.today.name).toBe(CUT)
    expect(ready.today.entries[0].name).toBe(CUT)
    expect(ready.others.map(o => o.name)).toEqual(['Pull'])
    const alone = buildReady({ ...S, week: {} }, '2026-10-13')
    expect(alone.others.map(o => o.name)).toEqual([CUT, 'B' + HUGE.slice(0, MAX_WIDGET_TEXT - 1), 'Pull'])
    expect(alone.others[0].entries[0].name).toBe(CUT)
    const snap = buildSnapshot({ ...S, active: { id: 'w1', name: 'Mine', entries: [{ id: 'c9', target: { name: HUGE }, sets: [{ r: 10, done: false }] }] } }, { ready: alone })
    expect(snap.active.entries[0].name).toBe(CUT)
    expect(bytesOf(snap)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  })

  it('cuts a shared slot\'s superset group id, and keeps the superset together', () => {
    const routineWithGroup = sg => ({ id: 'r9', name: 'Short', ex: [{ id: '0025', sets: 3, reps: 8, sg }, { id: '0001', sets: 2, reps: 10, sg }] })
    const snapOf = sg => {
      const S = { unit: 'kg', restSec: 90, workouts: [], routines: [], week: {}, dayPlan: {} }
      const { entries } = buildCombinedEntries(S, ['shared:s1'], viewOf(routineWithGroup(sg)))
      return buildSnapshot({ ...S, active: { id: 'w-9', name: 'Short', cur: 0, entries } })
    }
    const big = snapOf(HUGE)
    // both exercises still carry the same group, so the watch still runs them in turns
    expect(big.active.entries.map(e => e.group)).toEqual([CUT, CUT])
    expect(bytesOf(big)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(fitSnapshot(big)).toBe(big)
    // a group id at or under the limit is unchanged
    expect(snapOf('A').active.entries.map(e => e.group)).toEqual(['A', 'A'])
    expect(snapOf('g'.repeat(MAX_WIDGET_TEXT)).active.entries[0].group).toBe('g'.repeat(MAX_WIDGET_TEXT))
  })

  it('counts code points, so an emoji at the cut is kept or dropped whole, and leaves short names alone', () => {
    const a = n => 'a'.repeat(n)
    const nameOf = name => buildSnapshot(state({ active: { ...state().active, name } })).active.name
    const entryNameOf = name => buildSnapshot(state({ active: { ...state().active, entries: [{ id: 'c9', target: { name }, sets: [] }] } })).active.entries[0].name
    for (const of of [nameOf, entryNameOf]) {
      // the 200th code point is the emoji: kept whole (201 UTF-16 units)
      expect(of(a(199) + '💪' + 'tail')).toBe(a(199) + '💪')
      // the emoji would be the 201st: dropped whole, not half of it
      expect(of(a(200) + '💪')).toBe(a(200))
      expect(of('💪'.repeat(300))).toBe('💪'.repeat(200))
      // at the limit and under it: unchanged
      expect(of(a(200))).toBe(a(200))
      expect(of('💪'.repeat(200))).toBe('💪'.repeat(200))
      expect(of('Push 💪')).toBe('Push 💪')
      for (const name of [a(199) + '💪💪', a(200) + '💪', '💪'.repeat(300)]) {
        const cut = of(name)
        expect([...cut].length).toBeLessThanOrEqual(MAX_WIDGET_TEXT)
        expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      }
    }
    // a catalogue exercise keeps its own title-cased name
    expect(buildSnapshot(state()).active.entries[0].name).toBe('Barbell Bench Press')
  })
})

describe('the events from the watch', () => {
  const ev = (id, over = {}) => ({ id, type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, w: 62.5, r: 7, at: 1, ...over })

  it('go through the workout screen\'s own action, once each', () => {
    const S = state()
    const setDone = vi.fn()
    bindWatchActions({ setDone })
    expect(applyEvents([ev('a'), ev('a')], () => ({ S }))).toEqual(['a', 'a'])
    expect(setDone).toHaveBeenCalledTimes(1)
    expect(setDone).toHaveBeenCalledWith(0, 1, { w: 62.5, r: 7, at: 1, hr: null })
    // …and again later (a second drain, a restart of the page): still once
    expect(applyEvents([ev('a')], () => ({ S }))).toEqual(['a'])
    expect(setDone).toHaveBeenCalledTimes(1)
  })

  it('find their exercise when the phone moved it, and drop what no longer exists', () => {
    const S = state()
    S.active.entries.reverse()
    const setDone = vi.fn()
    bindWatchActions({ setDone })
    expect(applyEvents([ev('moved'), ev('gone', { exId: '9999', entryIdx: 5 }), ev('other', { wid: 'w-2' })], () => ({ S }))).toEqual(['moved', 'gone', 'other'])
    expect(setDone).toHaveBeenCalledTimes(1)
    expect(setDone).toHaveBeenCalledWith(1, 1, { w: 62.5, r: 7, at: 1, hr: null })
  })

  it('wait in the queue while the workout screen is not there', () => {
    expect(applyEvents([ev('a')], () => ({ S: state() }))).toEqual([])
  })
})

describe('the native queue', () => {
  const plugin = events => ({ drain: vi.fn(async () => ({ events })), ack: vi.fn(async () => {}) })

  it('is drained when the workout screen binds, and acknowledged only for what was done', async () => {
    const S = state()
    const p = plugin([{ id: 'x1', type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, w: 60, r: 8 }])
    _setWatchPluginForTest(p, () => ({ S }))
    const setDone = vi.fn()
    bindWatchActions({ setDone })
    await drainWatchEvents()
    expect(setDone).toHaveBeenCalledWith(0, 1, { w: 60, r: 8, at: null, hr: null })
    expect(p.ack).toHaveBeenCalledWith({ ids: ['x1'] })
  })

  it('without the workout screen nothing is acknowledged: the events stay for later', async () => {
    const p = plugin([{ id: 'x1', type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1 }])
    _setWatchPluginForTest(p, () => ({ S: state() }))
    expect(await drainWatchEvents()).toEqual([])
    expect(p.ack).not.toHaveBeenCalled()
  })

  // Data safety (owner, 10-14): at launch S can be the empty copy of an evicted WebView until boot
  // has the file mirror back. A tick drained then found no workout and was acknowledged away.
  it('waits for the store to have its copy back before it applies or acknowledges anything', async () => {
    let store = { S: { unit: 'kg', workouts: [], active: null }, ready: false }
    const p = plugin([{ id: 'x1', type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, w: 60, r: 8 }])
    _setWatchPluginForTest(p, () => store)
    const setDone = vi.fn()
    bindWatchActions({ setDone })
    expect(await drainWatchEvents()).toEqual([])
    expect(p.drain).not.toHaveBeenCalled()
    expect(p.ack).not.toHaveBeenCalled()
    store = { S: state(), ready: true }
    expect(await drainWatchEvents()).toEqual(['x1'])
    expect(setDone).toHaveBeenCalledTimes(1)
  })

  it('acknowledges only once the change is saved: the queue is its last copy until then', async () => {
    const order = []
    const p = { drain: async () => ({ events: [{ id: 'x1', type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1 }] }), ack: async () => { order.push('ack') } }
    const saveNow = vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); order.push('saved') })
    _setWatchPluginForTest(p, () => ({ S: state(), ready: true, saveNow }))
    bindWatchActions({ setDone: () => order.push('applied') })
    await drainWatchEvents()
    expect(order).toEqual(['applied', 'saved', 'ack'])
  })

  it('off the iPhone app there is no plugin and nothing happens', async () => {
    _setWatchPluginForTest(null, () => ({ S: state() }))
    bindWatchActions({ setDone: vi.fn() })
    expect(await drainWatchEvents()).toEqual([])
  })
})

describe('starting and finishing on the watch', () => {
  const routines = [
    { id: 'r-push', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
    { id: 'r-pull', name: 'Pull', ex: [{ id: '0001', sets: 2, reps: 10 }] },
  ]

  it('the phone keeps today\'s session and the other routines ready, built as Start builds them', () => {
    const S = { unit: 'kg', workouts: [], routines, week: { 2: 'r-push' }, dayPlan: {} }
    const ready = buildReady(S, '2026-10-13')   // a Tuesday
    expect(ready.today).toMatchObject({ routineIds: ['r-push'], name: 'Push' })
    expect(ready.today.entries[0].sets).toHaveLength(3)
    expect(ready.others.map(o => o.routineIds)).toEqual([['r-pull']])
    const snap = buildSnapshot(S, { ready })
    expect(snap.active).toBeNull()
    expect(snap.ready.today.name).toBe('Push')
  })

  // #799: the watch's Apple Health workout used to be strength training whatever was planned.
  it('tells the watch which Apple Health type each session is', () => {
    const run = { id: 'r-run', name: 'Run', ex: [{ id: '0685', mode: 'cardio', min: 30, speed: 10 }] }
    const S = { unit: 'kg', workouts: [], routines: [...routines, run], week: { 2: 'r-run' }, dayPlan: {} }
    const ready = buildReady(S, '2026-10-13')
    expect(ready.today.healthType).toBe('running')
    expect(ready.others.map(o => o.healthType)).toEqual(['strength_training', 'strength_training'])
    const active = { id: 'w1', name: 'Run', entries: [{ id: '0685', target: { mode: 'cardio', min: 30 }, sets: [{ min: 30, speed: 10 }] }] }
    expect(buildSnapshot({ ...S, active }).active.healthType).toBe('running')
  })

  // The watch reads a snapshot whole or not at all: one odd routine must not cost it the others,
  // and an id that came in as a number must still reach it as text.
  it('one routine that cannot be built is left out, and every id goes as text', () => {
    const odd = [{ id: 'r-odd', name: 'Odd' }, { id: 7, name: 'Imported', ex: [{ id: 25, sets: 1, reps: 5 }] }, ...routines]
    const ready = buildReady({ unit: 'kg', workouts: [], routines: odd, week: { 2: 'r-push' }, dayPlan: {} }, '2026-10-13')
    expect(ready.today).toMatchObject({ routineIds: ['r-push'] })
    expect(ready.others.map(o => o.routineIds)).toEqual([['7'], ['r-pull']])
    expect(ready.others[0].entries[0].id).toBe('25')
  })

  // NATG-503 AC7: a routine over the session budget (buildCombinedEntries answers tooLarge, as
  // starting it on the phone is refused) is left out of the ready list too, as today's session or
  // as another routine, so the watch never offers what the phone would refuse.
  it('an over-budget session (buildCombinedEntries tooLarge) is left out of the ready list too', () => {
    // 11 exercises of 50 sets: each within the per-exercise limit, 550 rows together.
    const huge = { id: 'r-huge', name: 'Huge', ex: Array.from({ length: 11 }, () => ({ id: '0025', sets: 50, reps: 5, weight: 60 })) }
    const S = { unit: 'kg', workouts: [], routines: [huge, ...routines], week: { 2: 'r-push' }, dayPlan: {} }
    expect(buildCombinedEntries(S, ['r-huge'])).toMatchObject({ tooLarge: true, routines: [] })
    const ready = buildReady(S, '2026-10-13')
    expect(ready.today).toMatchObject({ routineIds: ['r-push'] })
    expect(ready.others.map(o => o.routineIds)).toEqual([['r-pull']])
    // Planned for today, it leaves today's slot empty rather than offering it.
    const planned = buildReady({ ...S, week: { 2: 'r-huge' } }, '2026-10-13')
    expect(planned.today).toBeNull()
    expect(planned.others.map(o => o.routineIds)).toEqual([['r-push'], ['r-pull']])
  })

  it('a start from the watch starts the session with the watch\'s id and time, once; the sets after it wait for the workout screen', () => {
    let S = { active: null }
    const start = vi.fn((ids, opts) => { S = { active: { id: opts.id, entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: false }] }] } } })
    bindWatchAppActions({ start })
    const events = [
      { id: 's1', type: 'start', routineIds: ['r-push'], wid: 'watch-1', at: 1700000000000 },
      { id: 'd1', type: 'setDone', wid: 'watch-1', exId: '0025', entryIdx: 0, setIdx: 0, w: 60, r: 8, at: 1700000100000 },
    ]
    expect(applyEvents(events, () => ({ S }))).toEqual(['s1'])
    expect(start).toHaveBeenCalledWith(['r-push'], { id: 'watch-1', start: 1700000000000 })
    const setDone = vi.fn(), finish = vi.fn()
    bindWatchActions({ setDone, finish })
    expect(applyEvents([...events, { id: 'f1', type: 'finish', wid: 'watch-1', at: 1700000200000 }], () => ({ S }))).toEqual(['s1', 'd1', 'f1'])
    expect(start).toHaveBeenCalledTimes(1)
    expect(setDone).toHaveBeenCalledWith(0, 0, { w: 60, r: 8, at: 1700000100000, hr: null })
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('a start while another workout runs on the phone keeps that one', () => {
    const S = { active: { id: 'phone-1', entries: [] } }
    const start = vi.fn()
    bindWatchAppActions({ start })
    expect(applyEvents([{ id: 's2', type: 'start', routineIds: ['r'], wid: 'watch-2', at: 1 }], () => ({ S }))).toEqual(['s2'])
    expect(start).not.toHaveBeenCalled()
  })
})

describe('heart rate from the watch', () => {
  it('rides on the tick when the reading holds up, and comes late for the rest through the app', () => {
    const S = state()
    const setDone = vi.fn(), patchSet = vi.fn()
    bindWatchActions({ setDone, finish: vi.fn() })
    bindWatchAppActions({ start: vi.fn(), patchSet })
    applyEvents([
      { id: 'h1', type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, w: 60, r: 8, at: 5, hr: { avg: 131.2, max: 150 } },
      { id: 'h2', type: 'setHr', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, restHr: { avg: 112, max: 128 } },
      { id: 'h3', type: 'setHr', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, restHr: { avg: 9000, max: 1 } },
    ], () => ({ S }))
    expect(setDone).toHaveBeenCalledWith(0, 1, { w: 60, r: 8, at: 5, hr: { avg: 131, max: 150 } })
    expect(patchSet).toHaveBeenCalledTimes(1)
    expect(patchSet).toHaveBeenCalledWith({ wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1 }, { restHr: { avg: 112, max: 128 } })
  })
})

describe('the workout\'s animations for the watch', () => {
  it('are what the phone shows: the built-in clip of each exercise in the app package', async () => {
    const { clipsFor } = await import('./watch-sync.js')
    const { EXIDX } = await import('./exercises.js')
    const clips = clipsFor(state(), {})
    expect(clips.map(c => c.exId)).toEqual(['0025', '0001'].filter(id => EXIDX[id]?.gif))
    for (const c of clips) {
      expect(c.path).toMatch(/^exercise-media\/clip\/[^/]+\.(mp4|webp)$/)
      expect(c.packId).toBeUndefined()
    }
    expect(clipsFor({ active: null }, {})).toEqual([])
  })

  it('or the downloaded 240 px pack of the figure, when it is there', async () => {
    const { clipsFor } = await import('./watch-sync.js')
    const packs = { 'anim-240-male': { state: 'ready', base: 'opengym-pack://anim-240-male' } }
    const clips = clipsFor(state(), packs)
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.packId).toBe('anim-240-male')
      expect(c.drawing).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(c.path).toBeUndefined()
    }
    // a pack that is not ready, or of the other figure, is not used
    expect(clipsFor(state(), { 'anim-240-female': { state: 'ready' } })[0].path).toBeDefined()
    expect(clipsFor(state(), { 'anim-240-male': { state: 'downloading' } })[0].path).toBeDefined()
  })
})

describe('the sync cases on the phone', () => {
  it('a tick that waits for the workout screen opens it, and stays queued until it is there', () => {
    const S = state()
    const openWorkout = vi.fn()
    bindWatchAppActions({ start: vi.fn(), patchSet: vi.fn(), openWorkout })
    expect(applyEvents([{ id: 'q1', type: 'setDone', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 1, w: 60, r: 8, at: 5 }], () => ({ S }))).toEqual([])
    expect(openWorkout).toHaveBeenCalledTimes(1)
  })

  it('a tick for a workout the phone already saved goes into that saved workout', () => {
    const S = { active: null, workouts: [{ id: 'w-old', entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: false }] }] }] }
    const patchSet = vi.fn()
    bindWatchAppActions({ start: vi.fn(), patchSet })
    expect(applyEvents([{ id: 'late', type: 'setDone', wid: 'w-old', exId: '0025', entryIdx: 0, setIdx: 0, w: 62.5, r: 7, at: 900, hr: { avg: 120, max: 140 } }], () => ({ S }))).toEqual(['late'])
    expect(patchSet).toHaveBeenCalledWith({ wid: 'w-old', exId: '0025', entryIdx: 0, setIdx: 0 }, { done: true, w: 62.5, r: 7, at: 900, hr: { avg: 120, max: 140 } }, { ifNewer: 900 })
  })

  it('the snapshot carries when each set was ticked, for the later-tick-wins rule on the watch', () => {
    const S = state()
    S.active.entries[0].sets[0].at = 1234
    expect(buildSnapshot(S).active.entries[0].sets[0].at).toBe(1234)
    expect('at' in buildSnapshot(S).active.entries[0].sets[1]).toBe(false)
  })
})

describe('patching a saved workout', () => {
  it('the later change wins; the watch\'s heart rate lands either way; the volume is counted again', async () => {
    const { patchSetIn } = await import('./watch-sync.js')
    const s = { active: null, workouts: [{ id: 'w', vol: 0, entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true, at: 2000 }] }] }] }
    const stamp = vi.fn(), recount = vi.fn(w => { w.vol = 1 })
    // the phone's edit (at 2000) is later than the watch's tick (at 1000): numbers stay, hr lands
    expect(patchSetIn(s, { wid: 'w', exId: '0025', entryIdx: 0, setIdx: 0 }, { done: true, w: 50, r: 5, at: 1000, hr: { avg: 110, max: 120 } }, stamp, { ifNewer: 1000, recount })).toBe(true)
    expect(s.workouts[0].entries[0].sets[0]).toEqual({ w: 60, r: 8, done: true, at: 2000, hr: { avg: 110, max: 120 } })
    // a later tick wins
    patchSetIn(s, { wid: 'w', exId: '0025', entryIdx: 0, setIdx: 0 }, { done: true, w: 65, r: 6, at: 3000 }, stamp, { ifNewer: 3000, recount })
    expect(s.workouts[0].entries[0].sets[0]).toMatchObject({ w: 65, r: 6, at: 3000 })
    expect(recount).toHaveBeenCalledTimes(2)
    expect(s.workouts[0].vol).toBe(1)
  })
})
