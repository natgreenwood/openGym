// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { freshStore, releaseStores } from './fresh-store.js'
import { api } from '../lib/api.js'

vi.mock('../lib/api.js', () => ({ api: vi.fn(async () => { throw new TypeError('Failed to fetch') }), setRemoteAuth: vi.fn() }))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn(), stopRest: vi.fn(), abandonWork: vi.fn() }) } }))

const POLL_MS = 30000   // useStore's poll
// What the store asked the server, in order.
const sent = () => api.mock.calls.map(([path, o]) => (o?.method || 'GET') + ' ' + path)

// Another tab signing in as `to`: what the gym_owner 'storage' listener of every loaded store hears.
const ownerMoves = to => {
  const from = localStorage.getItem('gym_owner')
  localStorage.setItem('gym_owner', to)
  window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: from, newValue: to }))
}

describe('freshStore', () => {
  it('loads a new store each time, and its clean-up signs it out and takes its listeners off', async () => {
    localStorage.setItem('gym_owner', 'u1')
    const { useStore: first } = await freshStore()
    const { useStore: second } = await freshStore()
    expect(second).not.toBe(first)
    first.setState({ user: { id: 'u1' }, ready: true })

    // Loaded and not yet released, a store hears another tab's owner change and hands its copy over.
    const before = first.getState()
    ownerMoves('u2')
    expect(first.getState()).not.toBe(before)
    expect(first.getState().user).toBeNull()

    first.setState({ user: { id: 'u2' }, ready: true })
    releaseStores()
    expect(first.getState()).toMatchObject({ user: null, ready: false })
    expect(second.getState()).toMatchObject({ user: null, ready: false })

    // Released, neither store hears it any more.
    const kept = [first.getState(), second.getState()]
    ownerMoves('u3')
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    expect(first.getState()).toBe(kept[0])
    expect(second.getState()).toBe(kept[1])
    localStorage.clear()
  })

  // NATG-658: signed out, a store's poll still ran for the rest of the file, and would have
  // checked for the next test's account the moment it was signed in again.
  it('its clean-up stops the timers too: no poll, and no push still on its debounce', async () => {
    // Date too: the store holds back a check made within 3 s of the last one.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      localStorage.setItem('gym_owner', 'u1')
      localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: 100, uid: 'u1' }))
      const { useStore } = await freshStore()
      useStore.setState({ user: { id: 'u1' }, ready: true })
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(sent()).toEqual(['GET /api/data/rev'])   // loaded, the store polls

      useStore.getState().update(S => { S.restSec = 45 })   // and owes a push, on its debounce
      api.mockClear()
      releaseStores()
      useStore.setState({ user: { id: 'u1' }, ready: true })   // what a later test signing in would do
      await vi.advanceTimersByTimeAsync(POLL_MS * 10)
      expect(sent()).toEqual([])
    } finally {
      vi.useRealTimers()
      localStorage.clear()
    }
  })

  it('puts addEventListener back as it found it', async () => {
    const add = window.addEventListener
    const before = Object.getOwnPropertyDescriptor(window, 'addEventListener')
    await freshStore()
    expect(window.addEventListener).toBe(add)
    expect(Object.getOwnPropertyDescriptor(window, 'addEventListener')).toEqual(before)
  })

  // A test that has spied on window.addEventListener (NATG-615, found in testing): when the helper
  // recorded the listeners from outside, a spy made them go past it and outlive the test. The
  // store takes its own listeners off now (NATG-658), and a spy, wherever it was made, still sees
  // the store's calls and keeps none of them on.
  const spiedBefore = async () => { const spy = vi.spyOn(window, 'addEventListener'); return [spy, await freshStore()] }
  const spiedWhileLoading = async () => { const loading = freshStore(); const spy = vi.spyOn(window, 'addEventListener'); return [spy, await loading] }
  it.each([
    ['before freshStore(), restored before the clean-up', spiedBefore, true],
    ['before freshStore(), still on at the clean-up', spiedBefore, false],
    ['while the store loads, restored before the clean-up', spiedWhileLoading, true],
  ])('takes the listeners off with addEventListener spied on %s', async (_, load, restoreFirst) => {
    localStorage.setItem('gym_owner', 'u1')
    const [spy, { useStore }] = await load()
    expect(spy.mock.calls.map(([type]) => type)).toContain('storage')
    if (restoreFirst) spy.mockRestore()
    releaseStores()
    spy.mockRestore()

    const heard = vi.fn()
    const unsubscribe = useStore.subscribe(heard)
    ownerMoves('u2')
    unsubscribe()
    expect(heard).not.toHaveBeenCalled()
    localStorage.clear()
  })
})
