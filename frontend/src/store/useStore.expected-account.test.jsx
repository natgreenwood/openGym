// @vitest-environment happy-dom

/* X-Expected-Account (NATG-558). Every sync request names the account it is for (`expect`, which
   lib/api.js turns into the header on the cookie transport), and the server answers a session that
   is another account's with a 412. That answer is a plain failure: nothing read, nothing written,
   nothing merged, not a sign-out and not offline, and nothing sent again for that account. A push
   that was owed stays owed, under the account it was made for; what then happens to the copy is
   the ordinary handover when the other tab's sign-in writes the owner key. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast }) } }))

import { api } from '../lib/api.js'
import { DEF } from './useStore.js'
import { freshStore } from '../test-utils/fresh-store.js'

const clone = v => JSON.parse(JSON.stringify(v))
const workout = (id, d = '2026-09-20') => ({ id, d, start: 1, end: 2, entries: [] })
const calls = () => api.mock.calls.map(([p, o]) => (o?.method || 'GET') + ' ' + p)
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT')
const mismatch = () => Object.assign(new Error('session is for another account'), { status: 412, code: 'account-mismatch', data: { error: 'session is for another account', code: 'account-mismatch' } })
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
// What a refusal must leave as it was: the saved copy and where it stands with the server.
const KEPT = ['gym_state_v1', 'gym_state_wid', 'gym_sync', 'gym_dirty']
const snapshot = () => Object.fromEntries(KEPT.map(k => [k, localStorage.getItem(k)]))
// The routes the server holds to the expected account.
const SYNC = new Set(['/api/data', '/api/data/rev', '/api/shares'])
// Every call to them names u1, and no other call names anyone.
const expectAllNamed = () => {
  expect(api).toHaveBeenCalled()
  for (const [path, o] of api.mock.calls) {
    if (SYNC.has(path)) expect(o?.expect, `${o?.method || 'GET'} ${path}`).toBe('u1')
    else expect(o?.expect, path).toBeUndefined()
  }
}

const PROFILE = { ...clone(DEF), _ts: 100, workouts: [workout('w1')] }
const GUEST = { ...clone(DEF), _ts: 900, restSec: 120, workouts: [workout('g1', '2026-09-11')] }
const SERVER = { ...clone(DEF), _ts: 200, restSec: 60, workouts: [workout('w1'), workout('w2')], _rev: 4 }

// The account's copy, as a page loaded on a browser signed in to it sees it.
let useStore
const signedIn = async (S = clone(PROFILE), rev = 3) => {
  localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts, uid: 'u1' }))
  localStorage.setItem('gym_owner', 'u1')   // as setUser signs in
  ;({ useStore } = await freshStore())
  useStore.setState({ S, user: { id: 'u1' }, ready: true, sync: { offline: false, auth: false, pending: false, lastSynced: 0 } })
}
// A guest's copy signing in, with the sign-in's question to come (adoptProfile).
const signingIn = async ({ mark = false } = {}) => {
  ;({ useStore } = await freshStore())
  useStore.setState({ S: clone(GUEST), ready: true })
  useStore.getState().setUser({ id: 'u1', name: 'U' }, mark ? { adopt: true } : undefined)
}
const refusedState = () => {
  const { sync, user } = useStore.getState()
  expect(sync).toMatchObject({ status: 'error', lastError: { status: 412, code: 'account-mismatch' }, auth: false, offline: false })
  expect(user).toEqual({ id: 'u1' })
}

beforeEach(() => {
  localStorage.clear()
  api.mockReset()
  toast.mockReset()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { vi.useRealTimers(); localStorage.clear() })

describe('every sync request names the account it is for', () => {
  it('the revision check', async () => {
    await signedIn()
    api.mockImplementation(async path => (path === '/api/data/rev' ? { rev: 3 } : null))
    window.dispatchEvent(new Event('online'))   // the poll, forced
    await settle()
    expect(calls()).toEqual(['GET /api/data/rev'])
    expectAllNamed()
  })

  it('a pull', async () => {
    await signedIn()
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    await useStore.getState().pullState()
    expect(calls()).toEqual(['GET /api/data'])
    expectAllNamed()
  })

  it('a push', async () => {
    await signedIn()
    api.mockResolvedValueOnce({ ok: true, rev: 4 })
    useStore.getState().update(s => { s.restSec = 45 })
    await useStore.getState().pushState()
    expect(calls()).toEqual(['PUT /api/data'])
    expectAllNamed()
  })

  it('a replace\'s read and its push (Reset everything)', async () => {
    await signedIn()
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 3 })
    api.mockResolvedValueOnce({ ok: true, rev: 4 })
    await useStore.getState().resetEverything()
    await useStore.getState().pushState()
    expect(calls()).toEqual(['GET /api/data', 'PUT /api/data'])
    expectAllNamed()
  })

  it('a sign-in\'s adoption: its read, the read again once answered, and its write', async () => {
    await signingIn()
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    api.mockResolvedValueOnce({ ok: true, rev: 5 })
    await useStore.getState().adoptProfile(async () => true)
    expect(calls()).toEqual(['GET /api/data', 'GET /api/data', 'PUT /api/data'])
    expectAllNamed()
  })

  it('an import\'s check of the server', async () => {
    await signedIn()
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    await useStore.getState().importConflict({ ...clone(DEF), workouts: [workout('w1')] })
    expect(calls()).toEqual(['GET /api/data'])
    expectAllNamed()
  })

  it('the share lists', async () => {
    await signedIn()
    api.mockResolvedValueOnce({ outgoing: [], incoming: [], etag: 'e1' })
    await useStore.getState().loadShares()
    expect(calls()).toEqual(['GET /api/shares'])
    expectAllNamed()
  })
})

describe('a 412: the session is another account\'s', () => {
  it('a push is not merged or retried, and stays owed under the account it was made for', async () => {
    await signedIn()
    useStore.getState().update(s => { s.restSec = 45 })
    const S = useStore.getState().S
    const before = snapshot()
    api.mockRejectedValue(mismatch())

    await useStore.getState().pushState()
    await settle()

    expect(calls()).toEqual(['PUT /api/data'])
    expect(useStore.getState().S).toBe(S)
    expect(snapshot()).toEqual({ ...before, gym_dirty: '1' })
    expect(JSON.parse(localStorage.getItem('gym_sync')).uid).toBe('u1')
    refusedState()
    expect(useStore.getState().sync.pending).toBe(true)
    expect(toast).not.toHaveBeenCalled()

    // The other tab's sign-in writes the owner key: today's handover, and nothing more goes out.
    localStorage.setItem('gym_owner', 'u2')
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: 'u1', newValue: 'u2' }))
    await settle()
    expect(useStore.getState().user).toBeNull()
    expect(calls()).toEqual(['PUT /api/data'])
  })

  it('a revision check does not fall back to a full pull', async () => {
    await signedIn()
    api.mockRejectedValue(mismatch())
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(calls()).toEqual(['GET /api/data/rev'])
    refusedState()
  })

  it('a pull takes nothing and saves nothing', async () => {
    await signedIn()
    const S = useStore.getState().S
    const before = snapshot()
    api.mockRejectedValue(mismatch())
    await useStore.getState().pullState()
    await settle()
    expect(calls()).toEqual(['GET /api/data'])
    expect(useStore.getState().S).toBe(S)
    expect(snapshot()).toEqual(before)
    refusedState()
  })

  it('a replace\'s read is disarmed and the copy stays owed', async () => {
    await signedIn()
    api.mockRejectedValue(mismatch())
    await useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await settle()
    expect(calls()).toEqual(['GET /api/data'])
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    refusedState()
  })

  it('an import\'s check answers that the import is stale, not that there is nothing to warn about', async () => {
    await signedIn()
    const token = useStore.getState().importToken()
    api.mockRejectedValue(mismatch())
    const answer = await useStore.getState().importConflict({ ...clone(DEF), workouts: [workout('w1')] }, token)
    expect(answer).toEqual({ stale: true, token })
    expect(Object.isFrozen(answer)).toBe(true)
    expect(calls()).toEqual(['GET /api/data'])
  })

  it('an import\'s check that fails any other way still has nothing to warn about', async () => {
    await signedIn()
    api.mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500, data: {} }))
    expect(await useStore.getState().importConflict({ ...clone(DEF) })).toBeNull()
  })

  it('a sign-in\'s adoption read is refused: rethrown, still held, nothing written', async () => {
    await signingIn({ mark: true })
    api.mockRejectedValue(mismatch())
    await expect(useStore.getState().adoptProfile(vi.fn())).rejects.toMatchObject({ status: 412, code: 'account-mismatch' })
    expect(calls()).toEqual(['GET /api/data'])
    expect(useStore.getState().sync.held).toBe(true)
    expect(JSON.parse(localStorage.getItem('gym_adopt'))).toMatchObject({ uid: 'u1' })
    expect(useStore.getState().sync.lastError).toEqual({ status: 412, code: 'account-mismatch' })
  })

  it('a sign-in\'s adoption write is refused: held again, and the sign-in\'s mark survives', async () => {
    await signingIn({ mark: true })
    api.mockResolvedValueOnce({ state: null, rev: 0 })   // a profile with nothing yet: the copy moves in
    api.mockRejectedValueOnce(mismatch())
    expect(await useStore.getState().adoptProfile(vi.fn())).toEqual({ adopted: false, added: false })
    expect(calls()).toEqual(['GET /api/data', 'PUT /api/data'])
    expect(puts()).toHaveLength(1)
    expect(useStore.getState().sync.held).toBe(true)
    expect(JSON.parse(localStorage.getItem('gym_adopt'))).toMatchObject({ uid: 'u1' })
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(useStore.getState().sync.lastError).toEqual({ status: 412, code: 'account-mismatch' })
  })

  it('the share lists say they could not load, forget their etag, and are not asked again', async () => {
    await signedIn()
    api.mockResolvedValueOnce({ outgoing: [], incoming: [], etag: 'e1' })
    await useStore.getState().loadShares()
    api.mockRejectedValue(mismatch())
    expect(await useStore.getState().loadShares()).toBeNull()
    await settle()
    expect(calls()).toEqual(['GET /api/shares', 'GET /api/shares'])
    expect(useStore.getState().sharesError).toBe(true)
    expect(useStore.getState().shares.etag).toBeNull()
  })
})
