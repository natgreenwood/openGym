// @vitest-environment happy-dom
// The phone's side of "open on the watch": a workout started on the phone opens the watch app
// (WatchBridge.openOnWatch, HealthKit's startWatchApp), and Apple Health on the watch follows the
// phone's Apple Health switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const health = vi.hoisted(() => ({ on: false, listeners: new Set() }))
vi.mock('./health-sync.js', () => ({
  loadHealth: async () => ({ on: health.on }),
  onHealthChange: cb => { health.listeners.add(cb); return () => health.listeners.delete(cb) },
}))

import { shouldOpenOnWatch, startWatchSync, applyEvents, bindWatchAppActions, markDiscarded, refusedWorkout, onRefusedWorkout, _setWatchPluginForTest, _resetWatchSync, OPEN_ON_WATCH_WINDOW_MS, SNAPSHOT_MAX_BYTES } from './watch-sync.js'
import { WATCH_DEFAULTS, writeWatchPrefs } from './watch-settings.js'

const now = 1_800_000_000_000
const live = (over = {}) => ({ id: 'w-9', start: now - 1000, entries: [], ...over })

beforeEach(() => { localStorage.clear(); _resetWatchSync(); health.on = false; health.listeners.clear() })

describe('which workouts open the watch app', () => {
  const prefs = { ...WATCH_DEFAULTS }
  it('a new one started here a moment ago', () => {
    expect(shouldOpenOnWatch(null, live(), { prefs, now })).toBe(true)
    expect(shouldOpenOnWatch(live({ id: 'old' }), live(), { prefs, now })).toBe(true)
  })
  it('not the same one again, nor none', () => {
    expect(shouldOpenOnWatch(live(), live({ cur: 2 }), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(live(), null, { prefs, now })).toBe(false)
  })
  it('not one restored at launch or synced in long after its start, nor a backfill', () => {
    expect(shouldOpenOnWatch(null, live({ start: now - OPEN_ON_WATCH_WINDOW_MS - 1 }), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live({ start: undefined }), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live({ backfill: { durationMin: 60 } }), { prefs, now })).toBe(false)
  })
  it('not with the switch off, or with the watch off altogether', () => {
    expect(shouldOpenOnWatch(null, live(), { prefs: { ...prefs, autoShow: false }, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live(), { prefs: { ...prefs, enabled: false }, now })).toBe(false)
  })
  it('not one the watch started itself', () => {
    const start = vi.fn()
    bindWatchAppActions({ start, patchSet: vi.fn() })
    applyEvents([{ id: 'e1', type: 'start', wid: 'w-9', at: now, routineIds: [] }], () => ({ S: { active: null } }))
    expect(start).toHaveBeenCalled()
    expect(shouldOpenOnWatch(null, live(), { prefs, now })).toBe(false)
    expect(shouldOpenOnWatch(null, live({ id: 'w-other' }), { prefs, now })).toBe(true)
  })
})

// A store as small as zustand's: getState, setState, subscribe((s, prev)).
function store(initial) {
  let st = initial
  const subs = new Set()
  return {
    getState: () => st,
    setState: patch => { const prev = st; st = { ...st, ...patch }; subs.forEach(fn => fn(st, prev)) },
    subscribe: fn => { subs.add(fn); return () => subs.delete(fn) },
  }
}

function bridge({ installed = true } = {}) {
  return {
    status: vi.fn(async () => ({ paired: true, installed })),
    sendSnapshot: vi.fn(async () => ({ sent: true })),
    sendClips: vi.fn(async () => ({})),
    openOnWatch: vi.fn(async () => ({ ok: true })),
    drain: vi.fn(async () => ({ events: [] })),
    ack: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: () => {} })),
  }
}

describe('startWatchSync', () => {
  const S0 = { unit: 'kg', restSec: 90, workouts: [], routines: [], active: null }
  const ui = store({ timer: null })

  it('opens the watch app for a workout started on the phone, once', async () => {
    const b = bridge()
    _setWatchPluginForTest(b)
    const st = store({ S: S0 })
    const stop = await startWatchSync({ useStore: st, useUI: ui })
    st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
    st.setState({ S: { ...S0, active: live({ start: Date.now(), cur: 1 }) } })
    await new Promise(r => setTimeout(r, 0))
    expect(b.openOnWatch).toHaveBeenCalledTimes(1)
    expect(b.openOnWatch).toHaveBeenCalledWith({ type: undefined })   // nothing in it yet: strength training
    stop()
  })

  it('opens the watch app as a run for a run (#799)', async () => {
    const b = bridge()
    _setWatchPluginForTest(b)
    const st = store({ S: S0 })
    const stop = await startWatchSync({ useStore: st, useUI: ui })
    const entries = [{ id: '0685', target: { mode: 'cardio', min: 30 }, sets: [{ min: 30, speed: 10 }] }]
    st.setState({ S: { ...S0, active: live({ start: Date.now(), entries }) } })
    await new Promise(r => setTimeout(r, 0))
    expect(b.openOnWatch).toHaveBeenCalledWith({ type: 'running' })
    stop()
  })

  it('leaves the watch alone without the app on it, or with the switch off', async () => {
    const b = bridge({ installed: false })
    _setWatchPluginForTest(b)
    const st = store({ S: S0 })
    const stop = await startWatchSync({ useStore: st, useUI: ui })
    st.setState({ S: { ...S0, active: live({ start: Date.now() }) } })
    stop()
    const b2 = bridge()
    _setWatchPluginForTest(b2)
    writeWatchPrefs({ autoShow: false })
    const st2 = store({ S: S0 })
    const stop2 = await startWatchSync({ useStore: st2, useUI: ui })
    st2.setState({ S: { ...S0, active: live({ id: 'w-10', start: Date.now() }) } })
    await new Promise(r => setTimeout(r, 0))
    expect(b.openOnWatch).not.toHaveBeenCalled()
    expect(b2.openOnWatch).not.toHaveBeenCalled()
    stop2()
  })

  // Data safety: an empty copy at launch (storage evicted, the file mirror not read back yet) must
  // not tell the watch its workout is over, nor drain its queue against nothing.
  it('sends nothing and drains nothing before the store has its copy back', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0, ready: false })
      _setWatchPluginForTest(b, () => st.getState())
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).not.toHaveBeenCalled()
      expect(b.drain).not.toHaveBeenCalled()
      st.setState({ S: { ...S0, active: live({ start: Date.now() - 3600e3 }) }, ready: true })
      await vi.runAllTimersAsync()
      expect(b.drain).toHaveBeenCalled()
      expect(JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).active.id).toBe('w-9')
      stop()
    } finally { vi.useRealTimers() }
  })

  // The link came up (WCSession activated) while the first status() was on its way: that
  // watchState event had no listener yet. The watch heard nothing until the app was reopened.
  it('sends to the watch when the link comes up during startup, before anyone listened', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      b.status.mockResolvedValueOnce({ activated: false, paired: false, installed: false })
      _setWatchPluginForTest(b)
      const stop = await startWatchSync({ useStore: store({ S: S0 }), useUI: ui })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  // A watch app installed or reinstalled while the phone app runs starts with nothing: the same
  // snapshot goes again (the native side stamps it, so iOS delivers it although it is unchanged).
  it('sends the same snapshot again when the watch link changes', async () => {
    vi.useFakeTimers()
    try {
      const b = bridge()
      const heard = {}
      b.addListener = vi.fn(async (name, fn) => { heard[name] = fn; return { remove: () => {} } })
      _setWatchPluginForTest(b)
      const stop = await startWatchSync({ useStore: store({ S: S0 }), useUI: ui })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(1)
      heard.watchState({ installed: true })
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
      expect(b.sendSnapshot.mock.calls[1][0].json).toBe(b.sendSnapshot.mock.calls[0][0].json)
      stop()
    } finally { vi.useRealTimers() }
  })

  it('tells the watch the phone\'s Apple Health switch, and again when it changes', async () => {
    vi.useFakeTimers()
    try {
      health.on = true
      const b = bridge()
      _setWatchPluginForTest(b)
      const st = store({ S: S0 })
      const stop = await startWatchSync({ useStore: st, useUI: ui })
      await vi.runAllTimersAsync()
      const sent = () => JSON.parse(b.sendSnapshot.mock.calls.at(-1)[0].json).settings
      expect(sent().health).toBe(true)
      health.listeners.forEach(fn => fn({ on: false }))
      await vi.runAllTimersAsync()
      expect(sent().health).toBe(false)
      stop()
    } finally { vi.useRealTimers() }
  })
})

// NATG-613, SEC-613-01: a workout too big for the watch even at its smallest is not sent, and the
// phone's goes on as it is. The settings (Apple Health off above all) still go, around the last
// workout the watch was sent, never one that would end the workout the watch holds.
describe('a workout too big for the watch', () => {
  const S0 = { unit: 'kg', restSec: 90, workouts: [], routines: [], active: null }
  // custom exercises with 200-emoji names (800 bytes each), four sets each: 500 of them never fit
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, target: { name: '💪'.repeat(200) }, sets: Array.from({ length: 4 }, () => ({ w: 60, r: 8, done: false })) }))
  const running = (n, id = 'w-9') => ({ ...S0, active: live({ id, start: 1, entries: rows(n) }) })
  const json = (b, i = -1) => b.sendSnapshot.mock.calls.at(i)[0].json
  const sent = (b, i = -1) => JSON.parse(json(b, i))
  const bytes = s => new TextEncoder().encode(s).length
  let warn
  beforeEach(() => { vi.useFakeTimers(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore(); vi.useRealTimers() })
  const start = async (S, { b = bridge(), timer = null } = {}) => {
    _setWatchPluginForTest(b)
    const st = store({ S })
    const stop = await startWatchSync({ useStore: st, useUI: store({ timer }) })
    await vi.runAllTimersAsync()
    const set = async S => { st.setState({ S }); await vi.runAllTimersAsync() }
    return { b, st, stop, set }
  }

  it('keeps the watch\'s workout, sends it again once with the settings, and warns once', async () => {
    const { b, st, stop, set } = await start(running(2), { timer: { endsAt: 5_000_000 } })
    expect(b.sendSnapshot).toHaveBeenCalledTimes(1)
    const first = sent(b)
    expect(first.active.rest).toEqual({ endsAt: 5_000_000 })
    const big = running(500)
    const bigBefore = JSON.stringify(big)
    await set(big)
    // what the watch holds, sent again around the settings: the same sets, and no old rest to restart
    expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(sent(b).active.entries)).toBe(JSON.stringify(first.active.entries))
    expect(sent(b).active.id).toBe('w-9')
    expect('rest' in sent(b).active).toBe(false)
    expect(bytes(json(b))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/^watch-sync: workout w-9 not sent, its snapshot is \d+ bytes, over the 49152-byte budget even when fitted \(500 rows\); the settings are sent with the last workout the watch was sent$/)
    // tick after tick of the same: nothing more to the bridge, nothing more in the log
    await set({ ...big })
    await set({ ...big })
    expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(st.getState().S)).toBe(bigBefore)
    // smaller again: the workout itself goes, as usual
    await set(running(1))
    expect(b.sendSnapshot).toHaveBeenCalledTimes(3)
    expect(sent(b).active.entries).toHaveLength(1)
    // too big again after that: said again
    await set(big)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(sent(b).active.entries).toHaveLength(1)
    stop()
  })

  it('sends today\'s settings and lists with it: Apple Health\'s deleted ids and the discarded workouts', async () => {
    health.on = true
    const { b, stop, set } = await start(running(2))
    expect(sent(b).settings.health).toBe(true)
    markDiscarded('w-gone')
    await set({ ...running(500), deleted: { workouts: { old: 5 } } })
    expect(sent(b).active.id).toBe('w-9')
    expect(sent(b).healthGone).toEqual(['opengym-w-old'])
    expect(sent(b).discarded).toEqual(['w-gone'])
    health.listeners.forEach(fn => fn({ on: false }))
    await vi.runAllTimersAsync()
    expect(sent(b).settings.health).toBe(false)
    expect(sent(b).healthGone).toBeUndefined()
    expect(sent(b).active.entries).toHaveLength(2)
    expect(bytes(json(b))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    stop()
  })

  it('tells the watch there is no workout only when the last one it was sent is another, or none', async () => {
    health.on = true
    // the watch was sent workout w-1; the phone now runs w-2, too big from the start
    const one = await start(running(2, 'w-1'))
    await one.set(running(500, 'w-2'))
    expect(sent(one.b).active).toBeNull()
    expect(warn.mock.calls.at(-1)[0]).toMatch(/workout w-2 not sent.*the settings are sent with no workout, as the watch was sent none of this one$/)
    health.listeners.forEach(fn => fn({ on: false }))
    await vi.runAllTimersAsync()
    expect(sent(one.b)).toMatchObject({ active: null, settings: { health: false } })
    one.stop()
    // the watch was sent no workout at all
    localStorage.clear()
    const none = await start(S0)
    expect(sent(none.b).active).toBeNull()
    await none.set(running(500))
    expect(sent(none.b).active).toBeNull()
    health.listeners.forEach(fn => fn({ on: false }))
    await vi.runAllTimersAsync()
    expect(sent(none.b)).toMatchObject({ active: null, settings: { health: false } })
    none.stop()
  })

  it('sends nothing without a record of what the watch was sent, and warns once a workout', async () => {
    const { b, stop, set } = await start(running(500))
    expect(b.sendSnapshot).not.toHaveBeenCalled()
    await set({ ...running(500) })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/workout w-9 not sent.*no record of what the watch holds/)
    await set(running(500, 'w-10'))
    expect(b.sendSnapshot).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
    stop()
  })

  it('knows what the watch was sent after a reload', async () => {
    const one = await start(running(2))
    const first = sent(one.b)
    await one.set(running(500))
    one.stop()
    // the page again: nothing in memory, the record in storage
    _resetWatchSync()
    const two = await start(running(500))
    expect(two.b.sendSnapshot).toHaveBeenCalledTimes(1)
    expect(sent(two.b).active.id).toBe('w-9')
    expect(JSON.stringify(sent(two.b).active.entries)).toBe(JSON.stringify(first.active.entries))
    two.stop()
  })

  // The Tester's storage probe: a record that could not be saved must never stand in for what the
  // watch received since. Read back, an older one ends the watch's workout (`active: null`) or
  // unticks a set it has.
  describe('when what was sent could not be kept', () => {
    const KEY = 'gym_watch_last_sent'
    let full = false, saving
    beforeEach(() => {
      full = false
      const setItem = localStorage.setItem.bind(localStorage)
      saving = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
        if (full && k === KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        return setItem(k, v)
      })
    })
    afterEach(() => saving.mockRestore())
    const firstDone = S => { const c = JSON.parse(JSON.stringify(S)); c.active.entries[0].sets[0] = { w: 60, r: 8, done: true, at: 100 }; return c }

    for (const failing of [true, false]) {
      it(`${failing ? '' : 'control, saving works: '}never ends the workout the watch was sent last (end)`, async () => {
        const { b, stop, set } = await start(S0)
        expect(sent(b).active).toBeNull()
        full = failing
        await set(running(1))
        expect(sent(b).active.id).toBe('w-9')
        expect(localStorage.getItem(KEY) === null).toBe(failing)
        await set(running(500))
        expect(b.sendSnapshot).toHaveBeenCalledTimes(3)
        expect(sent(b).active?.id).toBe('w-9')
        expect(bytes(json(b))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
        stop()
      })

      it(`${failing ? '' : 'control, saving works: '}never sends a done set as not done (rollback)`, async () => {
        const { b, stop, set } = await start(running(1))
        full = failing
        await set(firstDone(running(1)))
        expect(sent(b).active.entries[0].sets[0].done).toBe(true)
        await set(firstDone(running(500)))
        expect(b.sendSnapshot).toHaveBeenCalledTimes(3)
        expect(sent(b).active.entries[0].sets[0]).toMatchObject({ done: true, at: 100 })
        stop()
      })
    }

    it('after a reload, takes a record it could not keep as none, and sends nothing', async () => {
      const one = await start(running(1))
      full = true
      await one.set(firstDone(running(1)))
      one.stop()
      _resetWatchSync()
      const two = await start(firstDone(running(500)))
      expect(two.b.sendSnapshot).not.toHaveBeenCalled()
      expect(warn.mock.calls.at(-1)[0]).toMatch(/no record of what the watch holds/)
      two.stop()
    })
  })

  describe('when the workout sent again is over the budget too', () => {
    // A record of what the watch was sent, `room` bytes under the budget: one long name does it.
    const record = room => {
      const r = { v: 1, unit: 'kg', restSec: 90, active: { id: 'w-9', name: 'Big', unit: 'kg', cur: 0, restSec: 90, entries: [{ id: 'c0', name: '', mode: 'reps', sets: [{ w: 60, r: 8, done: false, warmup: false }] }] } }
      r.active.entries[0].name = 'x'.repeat(SNAPSHOT_MAX_BYTES - room - bytes(JSON.stringify(r)))
      expect(bytes(JSON.stringify(r))).toBe(SNAPSHOT_MAX_BYTES - room)
      localStorage.setItem('gym_watch_last_sent', JSON.stringify(r))
    }
    // 60 deleted workouts with long ids: about 7 KB of Apple Health ids
    const deleted = { workouts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['d'.repeat(100) + i, i + 1])) }

    it('leaves Apple Health\'s deleted ids out first, never the discarded workouts', async () => {
      health.on = true
      record(3000)
      markDiscarded('w-gone')
      const { b, stop } = await start({ ...running(500), deleted })
      expect(b.sendSnapshot).toHaveBeenCalledTimes(1)
      expect(sent(b).active.id).toBe('w-9')
      expect(sent(b).healthGone).toBeUndefined()
      expect(sent(b).discarded).toEqual(['w-gone'])
      expect(bytes(json(b))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
      stop()
    })

    it('sends nothing when it still does not fit, and warns once', async () => {
      health.on = true
      record(20)
      const { b, stop, set } = await start({ ...running(500), deleted })
      await set({ ...running(500), deleted })
      expect(b.sendSnapshot).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toMatch(/workout w-9 not sent.*the last snapshot sent is over the budget too$/)
      stop()
    })
  })

  // NATG-650: the workout screen says so while the running workout is refused (refusedWorkout),
  // and stops once a snapshot of it that fits reaches the watch, or the workout ends.
  describe('what the workout screen is told', () => {
    let heard
    beforeEach(() => { heard = vi.fn(); onRefusedWorkout(heard) })

    it('the first refusal names the workout, and the settings sent around it do not take it back (AC2, AC3)', async () => {
      const { b, stop, set } = await start(running(2))
      expect(refusedWorkout()).toBeNull()
      await set(running(500))
      // the fallback went out, with the last workout the watch got: still refused
      expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
      expect(sent(b).active.entries).toHaveLength(2)
      expect(refusedWorkout()).toBe('w-9')
      expect(heard).toHaveBeenCalledTimes(1)
      // again and again: the same, said once
      await set({ ...running(500) })
      health.listeners.forEach(fn => fn({ on: true }))
      await vi.runAllTimersAsync()
      expect(b.sendSnapshot).toHaveBeenCalledTimes(3)
      expect(sent(b).active.entries).toHaveLength(2)
      expect(refusedWorkout()).toBe('w-9')
      expect(heard).toHaveBeenCalledTimes(1)
      stop()
    })

    it('also when nothing at all could go to the watch (AC2)', async () => {
      const { b, stop } = await start(running(500))
      expect(b.sendSnapshot).not.toHaveBeenCalled()
      expect(refusedWorkout()).toBe('w-9')
      stop()
    })

    it('ends once a snapshot of the workout that fits is on the watch (AC3)', async () => {
      const { b, stop, set } = await start(running(500))
      expect(refusedWorkout()).toBe('w-9')
      await set(running(3))
      expect(sent(b).active.entries).toHaveLength(3)
      expect(refusedWorkout()).toBeNull()
      // too large again: said again
      await set(running(500))
      expect(refusedWorkout()).toBe('w-9')
      stop()
    })

    it('not while the snapshot that fits has not reached the watch', async () => {
      const b = bridge()
      const { stop, set } = await start(running(500), { b })
      b.sendSnapshot.mockImplementation(async () => ({ sent: false }))
      await set(running(3))
      expect(refusedWorkout()).toBe('w-9')
      b.sendSnapshot.mockImplementation(async () => ({ sent: true }))
      await set({ ...running(3) })
      expect(refusedWorkout()).toBeNull()
      stop()
    })

    for (const how of ['finished', 'discarded']) {
      it(`ends at once when the workout is ${how} (AC3)`, async () => {
        const { st, stop } = await start(running(500))
        expect(refusedWorkout()).toBe('w-9')
        if (how === 'discarded') markDiscarded('w-9')
        st.setState({ S: how === 'finished' ? { ...S0, workouts: [{ id: 'w-9' }] } : S0 })
        expect(refusedWorkout()).toBeNull()
        await vi.runAllTimersAsync()
        expect(refusedWorkout()).toBeNull()
        stop()
      })
    }

    it('is about that workout only: another one starts with nothing to say', async () => {
      const { st, stop, set } = await start(running(500))
      expect(refusedWorkout()).toBe('w-9')
      st.setState({ S: running(2, 'w-10') })
      expect(refusedWorkout()).toBeNull()
      await set(running(500, 'w-10'))
      expect(refusedWorkout()).toBe('w-10')
      stop()
    })

    it('never for a workout that fits (AC4)', async () => {
      const { b, stop, set } = await start(running(2))
      await set(running(40))
      await set({ ...running(40) })
      expect(b.sendSnapshot).toHaveBeenCalledTimes(2)
      expect(refusedWorkout()).toBeNull()
      expect(heard).not.toHaveBeenCalled()
      stop()
    })

    it('never without a watch with the app, and not once it is gone (A3)', async () => {
      const lonely = await start(running(500), { b: bridge({ installed: false }) })
      expect(lonely.b.sendSnapshot).not.toHaveBeenCalled()
      expect(refusedWorkout()).toBeNull()
      lonely.stop()
      // refused, then the watch goes: the link's own event asks again and finds none
      const b = bridge()
      const on = {}
      b.addListener = vi.fn(async (name, fn) => { on[name] = fn; return { remove: () => {} } })
      const { stop } = await start(running(500), { b })
      expect(refusedWorkout()).toBe('w-9')
      b.status.mockImplementation(async () => ({ paired: true, installed: false }))
      on.watchState()
      await vi.runAllTimersAsync()
      expect(refusedWorkout()).toBeNull()
      stop()
    })

    it('never with sending to the watch off, and not once it is switched off (A3)', async () => {
      writeWatchPrefs({ enabled: false })
      const off = await start(running(500))
      expect(sent(off.b).active).toBeNull()
      expect(refusedWorkout()).toBeNull()
      off.stop()
      writeWatchPrefs({ enabled: true })
      const { stop } = await start(running(500))
      expect(refusedWorkout()).toBe('w-9')
      writeWatchPrefs({ enabled: false })
      await vi.runAllTimersAsync()
      expect(refusedWorkout()).toBeNull()
      stop()
    })
  })
})
