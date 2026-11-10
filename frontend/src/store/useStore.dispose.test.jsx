// @vitest-environment happy-dom

/* NATG-658: disposeStore, what a test's clean-up runs on each store it loaded
   (test-utils/fresh-store.js). Signing a store out left its poll running for the rest of the file;
   a disposed store asks the server nothing more, sends no change still on its debounce, and hears
   none of the page's events. The app itself never disposes of its store: a sign-out keeps the poll
   going for whoever signs in next. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn(), stopRest: vi.fn(), abandonWork: vi.fn() }) } }))
// The phone app's return to the foreground (lib/mobile.js onAppActive), as a listener with a handle
// to take it off by: how many were added, and how many taken off.
const app = vi.hoisted(() => ({ added: 0, removed: 0 }))
vi.mock('../lib/mobile.js', async importOriginal => ({
  ...(await importOriginal()),
  onAppActive: () => { app.added++; return Promise.resolve({ remove: async () => { app.removed++ } }) },
}))

import { api } from '../lib/api.js'
import { DEF } from './useStore.js'
import { freshStore } from '../test-utils/fresh-store.js'

const clone = v => JSON.parse(JSON.stringify(v))
const POLL_MS = 30000
const CHECK_MIN_MS = 3000   // checks closer together than this are taken as one (useStore checkRev)
const USER = { id: 'user-1' }
const revChecks = () => api.mock.calls.filter(([path]) => path === '/api/data/rev').length
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT').length

// A store loaded signed in, its copy synced at revision 1: a check asks the server for its
// revision and nothing more.
async function signedIn() {
  localStorage.setItem('gym_owner', USER.id)
  localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: 100, uid: USER.id }))
  const store = await freshStore()
  store.useStore.setState({ S: { ...clone(DEF), _ts: 100 }, user: USER, ready: true })
  return store
}

beforeEach(() => {
  localStorage.clear()
  api.mockReset()
  api.mockImplementation(async path => (path === '/api/data/rev' ? { rev: 1 } : new Promise(() => {})))
  // Date too: the store holds back a check made within CHECK_MIN_MS of the last one.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('disposeStore', () => {
  it('stops the poll: no revision check comes after it, however long the page stays open', async () => {
    const { disposeStore } = await signedIn()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(revChecks()).toBe(1)   // live, the store polls

    disposeStore()
    await vi.advanceTimersByTimeAsync(POLL_MS * 10)
    expect(revChecks()).toBe(1)
  })

  it('drops a push still on its debounce', async () => {
    const { useStore, disposeStore } = await signedIn()
    useStore.getState().update(S => { S.restSec = 45 })
    disposeStore()
    await vi.advanceTimersByTimeAsync(5000)
    expect(puts()).toBe(0)
  })

  // Each event the store listens for, sent the way the page sends it, and whether it reached the
  // store: a revision check asked for, or the store's state replaced.
  const visible = () => document.dispatchEvent(new Event('visibilitychange'))
  const pageshow = () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  const syncedElsewhere = () => window.dispatchEvent(new StorageEvent('storage', { key: 'gym_sync', newValue: JSON.stringify({ rev: 2, ts: 200, uid: USER.id }) }))
  const ownerMoves = () => {
    localStorage.setItem('gym_owner', 'user-2')
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: USER.id, newValue: 'user-2' }))
  }
  it.each([
    ['focus', () => window.dispatchEvent(new Event('focus'))],
    ['online', () => window.dispatchEvent(new Event('online'))],
    ['pageshow', pageshow],
    ['visibilitychange', visible],
    ["another tab's sync ('storage')", syncedElsewhere],
    ["another tab's sign-in ('storage')", ownerMoves],
  ])('takes the store off %s', async (_, send) => {
    const reaches = async useStore => {
      await vi.advanceTimersByTimeAsync(CHECK_MIN_MS + 1)
      const checks = revChecks()
      const state = useStore.getState()
      send()
      await vi.advanceTimersByTimeAsync(0)
      return revChecks() > checks || useStore.getState() !== state
    }
    const live = await signedIn()
    expect(await reaches(live.useStore)).toBe(true)
    live.disposeStore()   // or it would answer the next event too, and count as the one reached

    const disposed = await signedIn()
    disposed.disposeStore()
    expect(await reaches(disposed.useStore)).toBe(false)
  })

  it.each([
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    ["the phone app's pause", () => document.dispatchEvent(new Event('pause'))],
  ])('takes the store off %s: a change made after it is not flushed there', async (_, send) => {
    const { useStore, disposeStore } = await signedIn()
    useStore.getState().update(S => { S.restSec = 45 })
    send()
    await vi.advanceTimersByTimeAsync(0)
    expect(puts()).toBe(1)   // live, the change owed goes at once

    disposeStore()
    useStore.getState().update(S => { S.restSec = 60 })
    send()
    await vi.advanceTimersByTimeAsync(0)
    expect(puts()).toBe(1)
  })

  it("takes the store off the phone app's return to the foreground", async () => {
    app.added = app.removed = 0
    const { disposeStore } = await signedIn()
    expect(app).toEqual({ added: 1, removed: 0 })
    disposeStore()
    await vi.advanceTimersByTimeAsync(0)
    expect(app).toEqual({ added: 1, removed: 1 })
  })

  // Whatever listener a later change adds: one left out of disposeStore fails here.
  it('takes off every listener the store added to window and document', async () => {
    const added = []
    for (const target of [window, document]) {
      const add = target.addEventListener
      vi.spyOn(target, 'addEventListener').mockImplementation(function (type, listener, options) {
        added.push({ type, options })
        return add.call(this, type, listener, options)
      })
    }
    const { disposeStore } = await signedIn()
    vi.restoreAllMocks()
    expect(added.map(({ type }) => type)).toEqual(expect.arrayContaining(['focus', 'online', 'pageshow', 'visibilitychange', 'pagehide', 'pause', 'storage']))

    disposeStore()
    expect(added.filter(({ options }) => !options?.signal?.aborted)).toEqual([])
  })
})
