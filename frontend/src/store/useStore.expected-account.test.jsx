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

// Tester, PR #115: once an operation meets a 412 it sends nothing more. Every request after it in
// the same operation would go out under the same session and be refused the same way.
describe('an operation that met a 412 sends nothing more', () => {
  const shared = { uid: 'u1', outgoing: [], incoming: [], etag: 'e0', fetchedAt: 0, names: {} }

  it('a pull after a reset: the reset\'s read is refused, and the pull does not read again', async () => {
    await signedIn()
    api.mockRejectedValue(mismatch())
    useStore.getState().resetEverything()
    await useStore.getState().pullState()
    await settle()
    expect(calls()).toEqual(['GET /api/data'])
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(JSON.parse(localStorage.getItem('gym_sync')).uid).toBe('u1')
    refusedState()
  })

  it('a pull after a queued push: the push is refused, and the pull does not read', async () => {
    await signedIn()
    api.mockRejectedValue(mismatch())
    useStore.getState().update(s => { s.restSec = 45 })   // waiting in the debounce
    await useStore.getState().pullState()
    await settle()
    expect(calls()).toEqual(['PUT /api/data'])
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    refusedState()
  })

  it('a pull after a push already in flight: refused, and the pull does not read', async () => {
    await signedIn()
    let refuse
    api.mockRejectedValue(mismatch())
    api.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(mismatch()) }))
    useStore.getState().update(s => { s.restSec = 45 })
    const push = useStore.getState().pushState()
    const pull = useStore.getState().pullState()
    refuse()
    await push; await pull
    await settle()
    expect(calls()).toEqual(['PUT /api/data'])
  })

  it('a change made while the refused push was out is not pushed after it, and stays owed', async () => {
    await signedIn()
    let refuse
    api.mockRejectedValue(mismatch())
    api.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(mismatch()) }))
    useStore.getState().update(s => { s.restSec = 45 })
    const push = useStore.getState().pushState()
    useStore.getState().update(s => { s.restSec = 50 })
    useStore.getState().pushState()   // asks for the follow-up
    refuse()
    await push
    await settle()
    expect(calls()).toEqual(['PUT /api/data'])
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).restSec).toBe(50)
  })

  it('a revision check whose share lists are refused does not go on to pull', async () => {
    await signedIn()
    useStore.setState({ shares: shared })
    api.mockImplementation(async path => {
      if (path === '/api/data/rev') return { rev: 4, shares: 'e1' }   // both moved
      throw mismatch()
    })
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(calls()).toEqual(['GET /api/data/rev', 'GET /api/shares'])
  })

  it('"Sync now" whose share lists are refused does not go on to pull', async () => {
    await signedIn()
    useStore.setState({ shares: shared })
    api.mockRejectedValue(mismatch())
    await useStore.getState().syncNow()
    await settle()
    expect(calls()).toEqual(['GET /api/shares'])
  })

  it('"Sync now" waiting on a pull that is refused sends nothing after it, not even the share lists', async () => {
    await signedIn()
    useStore.setState({ shares: shared })
    let refuse
    api.mockRejectedValue(mismatch())
    api.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(mismatch()) }))
    const pull = useStore.getState().pullState()
    const now = useStore.getState().syncNow()   // waits for that pull
    refuse()
    await pull; await now
    await settle()
    expect(calls()).toEqual(['GET /api/data'])
  })

  it('a sign-in\'s second read is refused: nothing is applied or written, and it fails as its first read would', async () => {
    await signingIn({ mark: true })
    const S = useStore.getState().S
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    api.mockRejectedValueOnce(mismatch())
    await expect(useStore.getState().adoptProfile(async () => true)).rejects.toMatchObject({ status: 412 })
    expect(calls()).toEqual(['GET /api/data', 'GET /api/data'])
    expect(useStore.getState().S).toBe(S)
    expect(useStore.getState().sync.held).toBe(true)
    expect(JSON.parse(localStorage.getItem('gym_adopt'))).toMatchObject({ uid: 'u1' })
    expect(useStore.getState().sync).toMatchObject({ status: 'error', auth: false, lastError: { status: 412, code: 'account-mismatch' } })
  })

  it('a sign-in whose write is refused does not push its kept changes after it', async () => {
    await signingIn()
    localStorage.setItem('gym_stash', JSON.stringify({ '|u1': { uid: 'u1', state: { ...clone(DEF), _ts: 50, workouts: [workout('kept', '2026-09-01')] } } }))
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    api.mockRejectedValue(mismatch())
    await useStore.getState().adoptProfile(async () => true)
    await settle()
    expect(calls()).toEqual(['GET /api/data', 'GET /api/data', 'PUT /api/data'])
    expect(localStorage.getItem('gym_stash')).not.toBeNull()   // kept for the next time it can go
  })

  // A bare adoption (no sign-in's hold), so the pull really goes out before it.
  it('an adoption waiting on a pull that was refused does not read', async () => {
    await signingIn()
    let refuse
    api.mockRejectedValue(mismatch())
    api.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(mismatch()) }))
    const pull = useStore.getState().pullState()
    const adopt = useStore.getState().adoptProfile(vi.fn())
    refuse()
    await pull
    await expect(adopt).rejects.toMatchObject({ status: 412 })
    expect(calls()).toEqual(['GET /api/data'])
    expect(useStore.getState().sync.held).toBe(false)   // a bare call has nothing to hold for
    expect(useStore.getState().sync).toMatchObject({ status: 'error', auth: false, lastError: { status: 412, code: 'account-mismatch' } })
  })

  it('a sign-out whose pull was refused pushes nothing after it, and keeps the owed copy', async () => {
    await signedIn()
    useStore.getState().update(s => { s.restSec = 45 })
    let refuse
    api.mockRejectedValue(mismatch())
    api.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(mismatch()) }))
    const pull = useStore.getState().pullState()   // sends the change waiting in the debounce first
    const out = useStore.getState().signOut()
    refuse()
    await pull
    const result = await out
    expect(calls()).toEqual(['PUT /api/data'])
    expect(result).toMatchObject({ owed: true })
    expect(useStore.getState().user).toEqual({ id: 'u1' })
  })
})

// Tester, PR #115: a 401 earlier, then a 412. The server knew the session this time, so it is not
// a sign-in problem: the screens say "a different account", not "sign in".
describe('a 412 after a 401', () => {
  it('leaves status error, not sign-in required', async () => {
    await signedIn()
    api.mockRejectedValueOnce(Object.assign(new Error('not signed in'), { status: 401, data: {} }))
    await useStore.getState().pullState()
    expect(useStore.getState().sync).toMatchObject({ status: 'auth', auth: true, lastError: { status: 401, code: 'auth' } })

    api.mockRejectedValueOnce(mismatch())
    await useStore.getState().pullState()
    refusedState()
    expect(calls()).toEqual(['GET /api/data', 'GET /api/data'])
  })
})

// Tester, PR #115 round 2: a refusal stops only what acts for the account it was for. A late 412
// for the account this tab has just switched from says nothing about the new account's session.
describe('a 412 for one account stops nothing for another', () => {
  const lists = uid => ({ uid, outgoing: [], incoming: [], etag: 'e-' + uid, fetchedAt: 0, names: {} })

  it('A\'s refused share lists landing during B\'s "Sync now" do not stop B\'s pull', async () => {
    await signedIn()
    useStore.setState({ shares: lists('u1') })
    let refuseA, answerB
    api.mockImplementation((path, o) => {
      if (path === '/api/shares' && o?.expect === 'u1') return new Promise((_, reject) => { refuseA = () => reject(mismatch()) })
      if (path === '/api/shares' && o?.expect === 'u2') return new Promise(resolve => { answerB = () => resolve({ outgoing: [], incoming: [], etag: 'eB' }) })
      if (path === '/api/data') return Promise.resolve({ state: clone(SERVER), rev: 4 })
      return Promise.resolve({})
    })
    const forA = useStore.getState().loadShares()
    await settle()
    useStore.getState().setUser({ id: 'u2', name: 'B' })   // this tab signs in as B meanwhile
    useStore.setState({ shares: lists('u2') })
    const now = useStore.getState().syncNow()
    await vi.waitFor(() => expect(answerB).toBeTypeOf('function'))
    refuseA()
    await forA
    answerB()
    await now
    const reads = api.mock.calls.filter(([p, o]) => p === '/api/data' && !o?.method).map(([, o]) => o.expect)
    expect(reads).toEqual(['u2'])
  })

  it('A\'s push refused after this tab switched to B does not stop B\'s pull that waited for it', async () => {
    await signedIn()
    let refuseA
    api.mockImplementation((path, o) => {
      if (o?.method === 'PUT' && o.expect === 'u1') return new Promise((_, reject) => { refuseA = () => reject(mismatch()) })
      if (path === '/api/data') return Promise.resolve({ state: clone(SERVER), rev: 4 })
      return Promise.resolve({})
    })
    useStore.getState().update(s => { s.restSec = 45 })
    const pushA = useStore.getState().pushState()
    await vi.waitFor(() => expect(refuseA).toBeTypeOf('function'))
    useStore.getState().setUser({ id: 'u2', name: 'B' })
    const pullB = useStore.getState().pullState()   // waits for the push still out
    refuseA()
    await pushA; await pullB
    const reads = api.mock.calls.filter(([p, o]) => p === '/api/data' && !o?.method).map(([, o]) => o.expect)
    expect(reads).toEqual(['u2'])
  })
})

// Architect, round 2: a sign-in's second read refused after the tab has been handed over answers
// as the first read does then (gone), not with a rejection for a toast in a tab that has moved on.
describe('a refused second read once the tab has left', () => {
  it('answers gone, and says nothing in the sync state', async () => {
    await signingIn()
    let refuse
    api.mockResolvedValueOnce({ state: clone(SERVER), rev: 4 })
    api.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(mismatch()) }))
    const adopt = useStore.getState().adoptProfile(async () => true)
    await vi.waitFor(() => expect(refuse).toBeTypeOf('function'))
    localStorage.setItem('gym_owner', 'u2')   // another tab signs in as someone else
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: 'u1', newValue: 'u2' }))
    refuse()
    await expect(adopt).resolves.toEqual({ adopted: false, added: false, gone: true })
    expect(calls()).toEqual(['GET /api/data', 'GET /api/data'])
    expect(useStore.getState().sync.lastError?.code).not.toBe('account-mismatch')
  })
})

// Tester, PR #115 round 3: an operation is for the account it started for, to the end. A's
// "Sync now" waiting on A's pull while the tab switches to B used to carry on for B once the pull
// landed: B's share lists and B's pull, each refused (412), two requests after a refusal.
describe('an operation never carries on for another account', () => {
  it('A\'s "Sync now" whose pull lands after the switch to B ends there, and sends nothing for B', async () => {
    await signedIn()
    useStore.setState({ shares: { uid: 'u1', outgoing: [], incoming: [], etag: 'e-u1', fetchedAt: 0, names: {} } })
    let answerA
    api.mockImplementation((path, o) => {
      if (path === '/api/data' && o?.expect === 'u1') return new Promise(resolve => { answerA = () => resolve({ state: clone(PROFILE), rev: 3 }) })
      if (o?.expect === 'u2') return Promise.reject(mismatch())   // B's session is not the browser's now
      return Promise.resolve({})
    })
    const pullA = useStore.getState().pullState()
    await vi.waitFor(() => expect(answerA).toBeTypeOf('function'))
    const nowA = useStore.getState().syncNow()   // waits for A's pull
    await settle()
    useStore.getState().setUser({ id: 'u2', name: 'B' })
    useStore.setState({ shares: { uid: 'u2', outgoing: [], incoming: [], etag: 'e-u2', fetchedAt: 0, names: {} } })
    answerA()
    await pullA; await nowA
    await settle()
    expect(api.mock.calls.filter(([, o]) => o?.expect === 'u2')).toEqual([])
    expect(calls()).toEqual(['GET /api/data'])
  })

  // The same switch with no refusal at all: A's operation still ends, rather than syncing B.
  it('A\'s "Sync now" does not sync B either when B\'s session would answer', async () => {
    await signedIn()
    let answerA
    api.mockImplementation((path, o) => {
      if (path === '/api/data' && o?.expect === 'u1') return new Promise(resolve => { answerA = () => resolve({ state: clone(PROFILE), rev: 3 }) })
      return Promise.resolve({ state: clone(SERVER), rev: 4, outgoing: [], incoming: [], etag: 'e' })
    })
    const pullA = useStore.getState().pullState()
    await vi.waitFor(() => expect(answerA).toBeTypeOf('function'))
    const nowA = useStore.getState().syncNow()
    await settle()
    useStore.getState().setUser({ id: 'u2', name: 'B' })
    answerA()
    await pullA; await nowA
    await settle()
    expect(api.mock.calls.filter(([, o]) => o?.expect === 'u2')).toEqual([])
  })
})
