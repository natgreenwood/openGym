// @vitest-environment happy-dom
// QA's regression for SEC-613-01 (NATG-613): Apple Health turned off on the phone reaches the watch
// within the budget while the running workout is too big to send, and the phone's workout is kept.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const health = vi.hoisted(() => ({ on: true, listeners: new Set() }))
vi.mock('./health-sync.js', () => ({
  loadHealth: async () => ({ on: health.on }),
  onHealthChange: fn => { health.listeners.add(fn); return () => health.listeners.delete(fn) },
}))

import { startWatchSync, _setWatchPluginForTest, _resetWatchSync, SNAPSHOT_MAX_BYTES } from './watch-sync.js'

function store(initial) {
  let state = initial
  const subscribers = new Set()
  return {
    getState: () => state,
    setState: patch => {
      const previous = state
      state = { ...state, ...patch }
      subscribers.forEach(fn => fn(state, previous))
    },
    subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) },
  }
}

beforeEach(() => {
  localStorage.clear()
  _resetWatchSync()
  health.on = true
  health.listeners.clear()
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it.each([1, 500])('delivers Health opt-out after the workout grows to %i rows', async count => {
  const bridge = {
    status: vi.fn(async () => ({ paired: true, installed: true })),
    sendSnapshot: vi.fn(async () => ({ sent: true })),
    sendClips: vi.fn(async () => ({})),
    drain: vi.fn(async () => ({ events: [] })),
    ack: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove() {} })),
  }
  _setWatchPluginForTest(bridge)
  const rows = n => Array.from({ length: n }, (_, i) => ({
    id: 'custom-' + i,
    target: { name: '💪'.repeat(200) },
    sets: Array.from({ length: 4 }, () => ({ w: 60, r: 8, done: false })),
  }))
  const initial = { unit: 'kg', restSec: 90, workouts: [], routines: [], active: { id: 'synthetic-workout', start: 1, entries: rows(1) } }
  const st = store({ S: initial })
  const stop = await startWatchSync({ useStore: st, useUI: store({ timer: null }) })
  try {
    await vi.runAllTimersAsync()
    const last = () => JSON.parse(bridge.sendSnapshot.mock.calls.at(-1)[0].json)
    expect(last().settings.health).toBe(true)
    const grown = { ...initial, active: { ...initial.active, entries: rows(count) } }
    const before = JSON.stringify(grown)
    st.setState({ S: grown })
    await vi.runAllTimersAsync()
    expect(health.listeners.size).toBe(1)
    health.on = false
    health.listeners.forEach(fn => fn({ on: false }))
    await vi.runAllTimersAsync()
    expect(JSON.stringify(st.getState().S)).toBe(before)
    expect(last().active.id).toBe('synthetic-workout')
    expect(new TextEncoder().encode(bridge.sendSnapshot.mock.calls.at(-1)[0].json).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(last().settings.health).toBe(false)
  } finally { stop() }
})
