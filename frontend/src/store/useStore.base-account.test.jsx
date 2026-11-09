// @vitest-environment happy-dom

/* The sync base names the account its revision was read for (NATG-556). A marker that names
   nobody, as every marker from before this did, or another account is no base: that copy takes
   the first-sync path. A merge or a push of a copy whose base is another account's writes
   nothing (not the copy, the marker or the owed flag) and says so. A copy with no base pulls
   before it pushes, except against a server known to have no revisions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF } from './useStore.js'

const clone = value => JSON.parse(JSON.stringify(value))
const workout = (id, d = '2026-09-01') => ({ id, d, start: 1, entries: [] })
const ids = S => (S.workouts || []).map(w => w.id)
const calls = () => api.mock.calls.map(([p, o]) => (o?.method || 'GET') + ' ' + p)
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT').map(([, o]) => JSON.parse(o.body))
const marker = () => JSON.parse(localStorage.getItem('gym_sync'))
const netError = () => new TypeError('Failed to fetch')
// What a refusal must leave as it was: the saved copy and where it stands with the server.
const KEPT = ['gym_state_v1', 'gym_state_wid', 'gym_sync', 'gym_dirty']
const snapshot = () => Object.fromEntries(KEPT.map(k => [k, localStorage.getItem(k)]))

// Each test loads its own store after writing storage, as a page load reads it.
let useStore
let stores = []
const load = async () => {
  vi.resetModules()
  ;({ useStore } = await import('./useStore.js'))
  stores.push(useStore)
  return useStore
}
const saved = (S, { owner, sync, dirty = false } = {}) => {
  if (owner) localStorage.setItem('gym_owner', owner)
  localStorage.setItem('gym_state_v1', JSON.stringify(S))
  if (sync) localStorage.setItem('gym_sync', JSON.stringify(sync))
  if (dirty) localStorage.setItem('gym_dirty', '1')
}
// A promise the test settles itself: an answer still on its way.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

let warn
beforeEach(() => {
  localStorage.clear()
  api.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  warn.mockRestore()
  localStorage.clear()
  for (const s of stores) s.setState({ S: clone(DEF), user: null, ready: false })
  stores = []
})

describe('a copy whose base is another account\'s', () => {
  // The copy this tab loaded is A's, with A's base, and owes A's server a change. The store now
  // names B, and the owner key says B: a continuation that outlived the switch, which every
  // per-call guard (answerIsFor) passes, because it only asks who is signed in now.
  const staleCopy = async ({ dirty = true } = {}) => {
    saved({ ...clone(DEF), _ts: 100, workouts: [workout('a1')] }, { owner: 'A', sync: { rev: 1, ts: 100, uid: 'A' }, dirty })
    await load()
    localStorage.setItem('gym_owner', 'B')
    useStore.setState({ user: { id: 'B' }, ready: true })
    return { S: useStore.getState().S, before: snapshot() }
  }
  const refusedWith = op => {
    expect(useStore.getState().sync).toMatchObject({ status: 'error', lastError: { status: 0, code: 'account-mismatch' } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(op)
    expect(warn.mock.calls[0][0]).toContain('A')
    expect(warn.mock.calls[0][0]).toContain('B')
  }

  // Whatever the server answers, a pull settles nothing for it: each of its branches would drop or
  // restamp A's base on the way to a push or an adopt, and the push check would then find B's base
  // on A's copy (Tester, PR #90).
  const answers = [
    ['a newer revision, with changes owed here', { state: { ...clone(DEF), _ts: 300, workouts: [workout('b1')], _rev: 5 }, rev: 5 }, true],
    ['no copy on the server yet', { state: null, rev: 0 }, true],
    ['a server without revisions', { state: { ...clone(DEF), _ts: 50, workouts: [workout('b-server')] } }, true],
    ['a newer revision, with nothing owed here', { state: { ...clone(DEF), _ts: 300, workouts: [workout('b1')], _rev: 5 }, rev: 5 }, false],
  ]
  for (const [what, answer, dirty] of answers) {
    it(`a pull answered with ${what} takes nothing, sends nothing, and the error is said`, async () => {
      const { S, before } = await staleCopy({ dirty })
      api.mockImplementation(async (path, o) => (o?.method === 'PUT' ? { ok: true, rev: 1 } : answer))

      await useStore.getState().pullState()
      await new Promise(r => setTimeout(r, 0))   // anything the answer would have started

      expect(calls()).toEqual(['GET /api/data'])
      expect(useStore.getState().S).toBe(S)
      expect(snapshot()).toEqual(before)
      refusedWith('pull')
    })
  }

  // The poll, with nothing owed: a revision equal to A's base used to confirm A's copy as in step
  // with B's server, rewriting when it last synced and what it looked like, and clearing the error.
  it('a poll whose revision matches the foreign base confirms nothing and leaves the error', async () => {
    localStorage.setItem('gym_synced_at', '12345')
    localStorage.setItem('gym_synced_fp', JSON.stringify({ s: 'a-fingerprint' }))
    const { S } = await staleCopy({ dirty: false })
    await useStore.getState().pushState()   // refused: the error is set
    expect(useStore.getState().sync.lastError).toEqual({ status: 0, code: 'account-mismatch' })
    const before = { ...snapshot(), at: localStorage.getItem('gym_synced_at'), fp: localStorage.getItem('gym_synced_fp') }
    api.mockImplementation(async path => (path === '/api/data/rev' ? { rev: 1 } : { state: null, rev: 1 }))

    window.dispatchEvent(new Event('online'))   // the poll, forced
    await new Promise(r => setTimeout(r, 20))

    expect(api).not.toHaveBeenCalled()
    expect({ ...snapshot(), at: localStorage.getItem('gym_synced_at'), fp: localStorage.getItem('gym_synced_fp') }).toEqual(before)
    expect(useStore.getState().S).toBe(S)
    expect(useStore.getState().sync).toMatchObject({ status: 'error', lastError: { status: 0, code: 'account-mismatch' } })
    expect(warn).toHaveBeenCalledTimes(2)   // the push, then the check
    expect(warn.mock.calls[1][0]).toContain('check')
  })

  // A sign-in's adoption reads the server itself, not through pullState, and each of its branches
  // restamped or dropped the base before pushing: A's copy went out as B's (Architect, PR #90).
  const signIns = [
    ['no copy on the server: nothing is asked, and nothing is forced over it', { state: null, rev: 0 }, null],
    ['B\'s copy on the server, and "add this device\'s data" answered yes', { state: { ...clone(DEF), _ts: 300, workouts: [workout('b-server')], _rev: 3 }, rev: 3 }, null],
    ['a sign-in that took this copy for the account\'s own', { state: { ...clone(DEF), _ts: 300, workouts: [workout('b1')], _rev: 5 }, rev: 5 }, { uid: 'B', rejoined: true }],
  ]
  for (const [what, answer, mark] of signIns) {
    it(`a sign-in's adoption takes nothing and sends nothing: ${what}`, async () => {
      const { S, before } = await staleCopy()
      if (mark) localStorage.setItem('gym_adopt', JSON.stringify(mark))
      api.mockImplementation(async (path, o) => (o?.method === 'PUT' ? { ok: true, rev: 9 } : answer))
      const ask = vi.fn(async () => true)

      const r = await useStore.getState().adoptProfile(ask)
      await new Promise(r => setTimeout(r, 0))   // anything the answer would have started

      expect(r).toMatchObject({ adopted: false, refused: true })
      expect(ask).not.toHaveBeenCalled()           // B is not asked about A's data
      expect(calls()).toEqual(['GET /api/data'])
      expect(useStore.getState().S).toBe(S)
      expect(snapshot()).toEqual(before)
      expect(localStorage.getItem('gym_state_owner')).not.toBe('B')   // not claimed as B's either
      expect(useStore.getState().sync.held).toBe(true)                // still held: nothing syncs
      refusedWith('adopt')
    })
  }

  // The invariant itself: whatever path asks to record a revision (here an import merged with the
  // server's copy, which records the revision it merged against), A's base stays, so the push
  // that follows is refused. The import may still save the copy here; it never reaches B's server.
  it('a path that records a revision leaves the foreign base in place, and the push is refused', async () => {
    await staleCopy()
    const marker = localStorage.getItem('gym_sync')
    const token = useStore.getState().importToken()
    const serverB = { ...clone(DEF), _ts: 300, workouts: [workout('b-server')], _rev: 7 }

    expect(useStore.getState().importBackup({ ...clone(DEF), _ts: 50, workouts: [workout('backup')] }, { mergeWith: { state: serverB, rev: 7, token }, token })).toBe(true)
    expect(localStorage.getItem('gym_sync')).toBe(marker)

    await useStore.getState().pushState()
    expect(api).not.toHaveBeenCalled()
    expect(localStorage.getItem('gym_sync')).toBe(marker)
    refusedWith('push')
  })

  it('is not pushed: nothing goes out, nothing here changes, and the error is said', async () => {
    const { S, before } = await staleCopy()

    await useStore.getState().pushState()

    expect(api).not.toHaveBeenCalled()
    expect(useStore.getState().S).toBe(S)
    expect(snapshot()).toEqual(before)
    refusedWith('push')
  })
})

describe('which marker is a base', () => {
  // In step with revision 1 (nothing owed, nothing changed since), with an older server copy of
  // its own. Used as a base: nothing to do. Not a base: the first sync, where the newer copy wins.
  const pullWith = async sync => {
    saved({ ...clone(DEF), _ts: 100, workouts: [workout('local')] }, { owner: 'u1', sync })
    await load()
    useStore.setState({ user: { id: 'u1' }, ready: true })
    api.mockImplementation(async (path, o) => (o?.method === 'PUT' ? { ok: true, rev: 2 } : { state: { ...clone(DEF), _ts: 50, workouts: [workout('server')], _rev: 1 }, rev: 1 }))
    await useStore.getState().pullState()
  }

  it('a marker stamped for the owner is used as before', async () => {
    await pullWith({ rev: 1, ts: 100, uid: 'u1' })
    expect(puts()).toHaveLength(0)
    expect(ids(useStore.getState().S)).toEqual(['local'])
    expect(marker()).toEqual({ rev: 1, ts: 100, uid: 'u1' })
  })

  for (const [what, sync] of [['an unstamped marker (from before this)', { rev: 1, ts: 100 }], ['a marker of another account', { rev: 1, ts: 100, uid: 'other' }]]) {
    it(`${what} takes the first-sync path, and the base it writes names the owner`, async () => {
      await pullWith(sync)
      expect(puts()).toHaveLength(1)
      expect(puts()[0].baseRev).toBe(1)
      expect(puts()[0].state.workouts.map(w => w.id)).toEqual(['local'])
      expect(marker()).toMatchObject({ rev: 2, uid: 'u1' })
    })
  }

  it('a signed-out tab follows another tab\'s sign-in only once the marker names the account', async () => {
    // Another tab signed in as u1 and saved u1's copy; this tab, signed out, loaded that copy.
    saved({ ...clone(DEF), _ts: 100, workouts: [workout('w1')] }, { owner: 'u1', sync: { rev: 3, ts: 100 } })
    localStorage.setItem('gym_state_wid', 'wid-1')
    localStorage.setItem('gym_state_owner', 'u1')
    await load()
    localStorage.setItem('gym_user', JSON.stringify({ id: 'u1', name: 'One' }))
    const moved = sync => {
      const v = JSON.stringify(sync)
      localStorage.setItem('gym_sync', v)
      window.dispatchEvent(new StorageEvent('storage', { key: 'gym_sync', newValue: v }))
    }

    moved({ rev: 3, ts: 100 })
    expect(useStore.getState().user).toBeNull()

    moved({ rev: 3, ts: 100, uid: 'u1' })
    expect(useStore.getState().user?.id).toBe('u1')
  })
})

describe('a push with no base', () => {
  it('sends nothing, stays owed, pulls, and the push that follows goes against the revision read', async () => {
    saved({ ...clone(DEF), _ts: 100, workouts: [workout('local')] }, { owner: 'u1' })
    await load()
    useStore.setState({ user: { id: 'u1' }, ready: true })
    const read = deferred()
    api.mockImplementation((path, o) => (o?.method === 'PUT' ? Promise.resolve({ ok: true, rev: 5 }) : read.promise))

    await useStore.getState().pushState()

    expect(calls()).toEqual(['GET /api/data'])
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(useStore.getState().sync.pending).toBe(true)

    read.resolve({ state: { ...clone(DEF), _ts: 200, workouts: [workout('server')], _rev: 4 }, rev: 4 })
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].baseRev).toBe(4)
    // Owed, so merged rather than taken or pushed over: both sides' workouts.
    expect(puts()[0].state.workouts.map(w => w.id).sort()).toEqual(['local', 'server'])
    await vi.waitFor(() => expect(localStorage.getItem('gym_dirty')).toBeNull())
    expect(marker()).toMatchObject({ rev: 5, uid: 'u1' })
    expect(useStore.getState().sync.lastError).toBeNull()
  })

  it('after the upgrade, a device that booted offline and then changes something is offline, not another account\'s', async () => {
    // The marker this device had before the update names no account: no base.
    saved({ ...clone(DEF), _ts: 100, workouts: [workout('w1')] }, { owner: 'u1', sync: { rev: 3, ts: 100 } })
    localStorage.setItem('gym_user', JSON.stringify({ id: 'u1', name: 'One' }))
    await load()
    api.mockRejectedValue(netError())
    await useStore.getState().boot()
    expect(useStore.getState().ready).toBe(true)

    useStore.getState().update(s => { s.workouts.push(workout('gym', '2026-09-02')) }, false)
    await useStore.getState().pushState()
    await vi.waitFor(() => expect(useStore.getState().sync.status).toBe('offline'))
    expect(useStore.getState().sync.lastError?.code).not.toBe('account-mismatch')
    expect(useStore.getState().sync.pending).toBe(true)
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(puts()).toHaveLength(0)

    // Back online: the pull writes the account's base and the change goes against revision 3.
    api.mockReset()
    api.mockImplementation(async (path, o) => (o?.method === 'PUT' ? { ok: true, rev: 4 } : { state: { ...clone(DEF), _ts: 100, workouts: [workout('w1')], _rev: 3 }, rev: 3 }))
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].baseRev).toBe(3)
    expect(puts()[0].state.workouts.map(w => w.id).sort()).toEqual(['gym', 'w1'])
    expect(warn).not.toHaveBeenCalled()
  })

  // Reset everything on a copy whose marker is from before the update: the reset armed for this
  // push must outlast the pull that writes the base, or it would go as an ordinary push and the
  // merge would bring the wiped entries back (the no-base branch returns before forceNext is read).
  it('a reset on a copy with an unstamped marker still replaces the server copy, once', async () => {
    const profile = { ...clone(DEF), _ts: 100, workouts: [workout('w1'), workout('w2', '2026-09-02')] }
    saved(profile, { owner: 'u1', sync: { rev: 3, ts: 100 } })
    await load()
    useStore.setState({ user: { id: 'u1' }, ready: true })
    api.mockImplementation(async (path, o) => (o?.method === 'PUT' ? { ok: true, rev: 4 } : { state: { ...clone(profile), _rev: 3 }, rev: 3 }))

    await useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    await new Promise(r => setTimeout(r, 20))   // and nothing after it

    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toBeUndefined()
    expect(puts()[0].state.workouts).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a server known to have no revisions is known for that account only', async () => {
    saved({ ...clone(DEF), _ts: 100, workouts: [workout('a1')] }, { owner: 'A' })
    await load()
    useStore.setState({ user: { id: 'A' }, ready: true })
    // A server from before revisions: no `rev` in any answer. A's copy goes as it always did.
    api.mockImplementation(async (path, o) => (o?.method === 'PUT' ? { ok: true } : path === '/api/data' ? { state: { ...clone(DEF), _ts: 50 } } : {}))
    await useStore.getState().pullState()
    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toBeUndefined()

    // B signs in here. Its copy has no base either, and the server's lack of revisions was known
    // for A: B's push asks first.
    useStore.getState().setUser({ id: 'B', name: 'B' })
    useStore.getState().update(s => { s.workouts.push(workout('b1')) }, false)
    api.mockReset()
    const read = deferred()
    api.mockImplementation((path, o) => (o?.method === 'PUT' ? Promise.resolve({ ok: true, rev: 1 }) : path === '/api/data' ? read.promise : Promise.resolve({})))
    await useStore.getState().pushState()
    expect(puts()).toHaveLength(0)
    expect(calls()).toContain('GET /api/data')
    read.resolve({ state: null, rev: 0 })
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].baseRev).toBe(0)
  })
})
