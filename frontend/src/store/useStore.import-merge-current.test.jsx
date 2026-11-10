// @vitest-environment happy-dom

/* NATG-562: "Merge them in" merged the backup with the server copy its check had read, and left
   this device's own copy out whenever it owed the server nothing at check time. A workout that
   reached this device after the check (another import's, here) was missing from the merged copy,
   which is persisted whole and pushed. The answer now always folds in this device's copy as it is
   when the user answers (useStore importBackup). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF } from './defaults.js'
import { warmStoreImports } from '../test-utils/warm-store.js'

await warmStoreImports()

const clone = v => JSON.parse(JSON.stringify(v))
const ids = xs => (xs || []).map(x => x.id).sort()
const workout = (id, d = '2026-09-20') => ({ id, d, start: 1, end: 2, entries: [] })
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT').map(([, o]) => JSON.parse(o.body))
const conflict = (state, rev) => Object.assign(new Error('HTTP 409'), { status: 409, data: { state, rev } })
const signedIn = async (S, rev) => {
  localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts }))
  localStorage.setItem('gym_owner', 'u1')
  vi.resetModules()
  ;({ useStore } = await import('./useStore.js'))
  useStore.setState({ S, user: { id: 'u1' }, ready: true, sync: { offline: false, pending: false, lastSynced: 0 } })
}
// The reporter's account: the server holds `a-only`, and so does this device, nothing owed.
const ACCOUNT = { ...clone(DEF), _ts: 200, workouts: [workout('a-only')] }
const FILE_1 = { ...clone(DEF), _ts: 50, workouts: [workout('file-1', '2026-09-21')] }

let useStore
beforeEach(() => { localStorage.clear(); api.mockReset() })
afterEach(() => { localStorage.clear(); useStore.setState({ S: clone(DEF), user: null, ready: false }) })

describe('"Merge them in" after this device moved on since the check', () => {
  it('keeps a workout that reached this device and the server after the check, locally and in the pushed copy', async () => {
    await signedIn(clone(ACCOUNT), 7)
    api.mockResolvedValueOnce({ state: clone(ACCOUNT), rev: 7 })
    const c = await useStore.getState().importConflict(FILE_1)
    expect(c).toMatchObject({ workouts: 1, rev: 7 })
    expect(c.local).toBeFalsy()                     // nothing owed at check time
    // Meanwhile this device gains file-2, and syncs it: the server is at rev 8 now.
    useStore.getState().update(s => { s.workouts.push(workout('file-2', '2026-09-22')) })
    api.mockResolvedValueOnce({ ok: true, rev: 8 })
    await useStore.getState().pushState()
    const atServer = clone(puts().at(-1).state)
    expect(ids(atServer.workouts)).toEqual(['a-only', 'file-2'])

    expect(useStore.getState().importBackup(FILE_1, { mergeWith: c })).toBe(true)
    expect(ids(useStore.getState().S.workouts)).toEqual(['a-only', 'file-1', 'file-2'])
    // The merge goes against the revision the check read (7); the server, at 8, refuses it.
    api.mockRejectedValueOnce(conflict(atServer, 8))
    api.mockResolvedValueOnce({ ok: true, rev: 9 })
    await useStore.getState().pushState()
    const [first, retry] = puts().slice(-2)
    expect(first.baseRev).toBe(7)
    expect(ids(first.state.workouts)).toEqual(['a-only', 'file-1', 'file-2'])
    expect(retry.baseRev).toBe(8)
    expect(ids(retry.state.workouts)).toEqual(['a-only', 'file-1', 'file-2'])
    expect(ids(useStore.getState().S.workouts)).toEqual(['a-only', 'file-1', 'file-2'])
  })

  it('keeps one that reached this device and is still waiting to be pushed: no 409 comes to bring it back', async () => {
    await signedIn(clone(ACCOUNT), 7)
    api.mockResolvedValueOnce({ state: clone(ACCOUNT), rev: 7 })
    const c = await useStore.getState().importConflict(FILE_1)
    // file-2 arrives here and the answer comes before its debounced push has gone.
    useStore.getState().update(s => { s.workouts.push(workout('file-2', '2026-09-22')) })
    expect(useStore.getState().importBackup(FILE_1, { mergeWith: c })).toBe(true)
    // The server is still at the revision the check read, so it takes the push as it is.
    api.mockResolvedValueOnce({ ok: true, rev: 8 })
    await useStore.getState().pushState()
    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toBe(7)
    expect(ids(puts()[0].state.workouts)).toEqual(['a-only', 'file-1', 'file-2'])
    expect(ids(useStore.getState().S.workouts)).toEqual(['a-only', 'file-1', 'file-2'])
  })

  it('a workout deleted on this device after the check stays deleted', async () => {
    await signedIn({ ...clone(ACCOUNT), workouts: [workout('a-only'), workout('gone', '2026-09-23')] }, 7)
    api.mockResolvedValueOnce({ state: clone(useStore.getState().S), rev: 7 })
    const c = await useStore.getState().importConflict(FILE_1)
    useStore.getState().update(s => { s.workouts = s.workouts.filter(w => w.id !== 'gone') })
    useStore.getState().importBackup(FILE_1, { mergeWith: c })
    expect(ids(useStore.getState().S.workouts)).toEqual(['a-only', 'file-1'])
  })
})
