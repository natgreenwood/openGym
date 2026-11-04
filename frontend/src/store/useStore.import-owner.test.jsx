// @vitest-environment happy-dom

/* NATG-535: Settings > Import backup reads the account's server copy (importConflict), then waits
   on a confirm for as long as the user takes. Another tab could sign out, switch account or sign in
   from guest meanwhile, and any choice on the confirm then wrote into whoever was here now:
   "Merge them in" put account A's server workouts into B's profile against A's revision, and
   "Replace anyway" or the plain Import replaced B's data on a warning that counted A's. The import
   is now refused whole once the account its check was for has gone, whichever choice was made. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF, useStore } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const ids = xs => (xs || []).map(x => x.id)
const workout = (id, d = '2026-09-20') => ({ id, d, start: 1, end: 2, entries: [] })
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT')
const BACKUP = { ...clone(DEF), _ts: 50, restSec: 120, workouts: [workout('w1'), workout('w2')] }
const SERVER_A = { ...clone(DEF), _ts: 300, restSec: 60, workouts: [workout('w1'), workout('w2'), workout('a-only', '2026-09-26')], _rev: 7 }

const signedIn = (uid, S, rev) => {
  localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts }))
  localStorage.setItem('gym_owner', uid)   // as setUser signs in
  useStore.setState({ S, user: { id: uid }, ready: true, sync: { offline: false, pending: false, lastSynced: 0 } })
}
const guest = S => {
  localStorage.removeItem('gym_owner')
  useStore.setState({ S, user: null, ready: true })
}
// Another tab of this browser: its sign-out or sign-in writes the owner key first, and this tab's
// storage event for it runs later (useStore's gym_owner listener).
const otherTab = owner => {
  if (owner) localStorage.setItem('gym_owner', owner); else localStorage.removeItem('gym_owner')
}
const ownerEvent = () => window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner' }))

// The confirm's answer, for each way into it: A signed in with a server workout the backup lacks,
// or a guest with a workout on this device the backup lacks.
async function askedAsA() {
  signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
  api.mockResolvedValueOnce({ state: clone(SERVER_A), rev: 7 })
  const c = await useStore.getState().importConflict(BACKUP)
  expect(c).toMatchObject({ workouts: 1, uid: 'A' })
  return c
}
async function askedAsGuest() {
  guest({ ...clone(DEF), _ts: 200, workouts: [workout('w1'), workout('guest-only', '2026-09-28')] })
  const c = await useStore.getState().importConflict(BACKUP)
  expect(c).toMatchObject({ workouts: 1, device: true, uid: null })
  return c
}

// What "nothing imported" means: the copy and its saved form stay as they were, and nothing goes
// to the server, not even after the push debounce.
function expectNothingImported(run) {
  const S = useStore.getState().S
  const saved = localStorage.getItem('gym_state_v1')
  const before = puts().length
  expect(run()).toBe(false)
  expect(useStore.getState().S).toBe(S)
  expect(localStorage.getItem('gym_state_v1')).toBe(saved)
  vi.advanceTimersByTime(5000)
  expect(puts().length).toBe(before)
}

const CHOICES = [
  ['"Merge them in"', c => useStore.getState().importBackup(BACKUP, { mergeWith: c })],
  ['"Replace anyway"', () => useStore.getState().importBackup(BACKUP, { mergeWith: null })],
]

beforeEach(() => { localStorage.clear(); api.mockReset(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

// First in the file: the owner events further down leave this store handed over to the new
// owner (it writes nothing until it has taken that owner's saved copy), as a real tab would be.
describe('with no account change, the import goes as before', () => {
  it('"Merge them in" as A', async () => {
    const c = await askedAsA()
    expect(useStore.getState().importIsCurrent(c)).toBe(true)
    expect(useStore.getState().importBackup(BACKUP, { mergeWith: c })).toBe(true)
    expect(ids(useStore.getState().S.workouts)).toEqual(['w1', 'w2', 'a-only'])
  })

  it('"Replace anyway" as a guest', async () => {
    await askedAsGuest()
    expect(useStore.getState().importIsCurrent(null)).toBe(true)
    expect(useStore.getState().importBackup(BACKUP)).toBe(true)
    expect(ids(useStore.getState().S.workouts)).toEqual(['w1', 'w2'])
  })
})

describe('the account changes while the import confirm is open', () => {
  for (const [choice, press] of CHOICES) {
    describe(choice, () => {
      it('A → B: refused, whether or not this tab has heard of the switch yet', async () => {
        const c = await askedAsA()
        otherTab('B')
        expect(useStore.getState().importIsCurrent(c)).toBe(false)
        expectNothingImported(() => press(c))

        const c2 = await askedAsA()
        otherTab('B')
        ownerEvent()
        useStore.setState({ user: { id: 'B' } })   // as followSignIn takes B on
        expectNothingImported(() => press(c2))
      })

      it('A → signed out: refused', async () => {
        const c = await askedAsA()
        otherTab(null)
        expectNothingImported(() => press(c))

        const c2 = await askedAsA()
        otherTab(null)
        ownerEvent()
        expect(useStore.getState().user).toBeNull()
        expectNothingImported(() => press(c2))
      })

      it('guest → B: refused', async () => {
        const c = await askedAsGuest()
        otherTab('B')
        expect(useStore.getState().importIsCurrent(c)).toBe(false)
        expectNothingImported(() => press(c))

        const c2 = await askedAsGuest()
        otherTab('B')
        ownerEvent()
        useStore.setState({ user: { id: 'B' } })
        expectNothingImported(() => press(c2))
      })
    })
  }

  it('the plain "Import backup?" confirm (no conflict to warn about) is refused the same way', async () => {
    signedIn('A', clone(DEF), 6)
    api.mockResolvedValueOnce({ state: clone(BACKUP), rev: 7 })
    expect(await useStore.getState().importConflict(BACKUP)).toBeNull()
    otherTab('B')
    expect(useStore.getState().importIsCurrent(null)).toBe(false)
    expectNothingImported(() => useStore.getState().importBackup(BACKUP))

    guest(clone(DEF))
    expect(await useStore.getState().importConflict(BACKUP)).toBeNull()
    otherTab('B')
    expectNothingImported(() => useStore.getState().importBackup(BACKUP))
  })

  it('a switch while the check is still asking the server leaves nothing to confirm', async () => {
    signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
    let answer
    api.mockReturnValueOnce(new Promise(r => { answer = r }))
    const asking = useStore.getState().importConflict(BACKUP)
    otherTab('B')
    answer({ state: clone(SERVER_A), rev: 7 })
    const c = await asking
    expect(c).toBeNull()
    expect(useStore.getState().importIsCurrent(c)).toBe(false)
    expectNothingImported(() => useStore.getState().importBackup(BACKUP))
  })
})
