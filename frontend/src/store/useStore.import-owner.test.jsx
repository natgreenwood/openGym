// @vitest-environment happy-dom

/* NATG-535: Settings > Import backup reads the account's server copy (importConflict), then waits
   on a confirm for as long as the user takes. Another tab could sign out, switch account or sign in
   from guest meanwhile, and any choice on the confirm then wrote into whoever was here now:
   "Merge them in" put account A's server workouts into B's profile against A's revision, and
   "Replace anyway" or the plain Import replaced B's data on a warning that counted A's. Each import
   now carries a token of the account it began under (importToken), taken when the file is chosen,
   and is refused whole once that token no longer holds, whichever choice was made. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const ids = xs => (xs || []).map(x => x.id)
const workout = (id, d = '2026-09-20') => ({ id, d, start: 1, end: 2, entries: [] })
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT')
const reads = () => api.mock.calls.filter(([path]) => path === '/api/data')
const BACKUP = { ...clone(DEF), _ts: 50, restSec: 120, workouts: [workout('w1'), workout('w2')] }
const SERVER_A = { ...clone(DEF), _ts: 300, restSec: 60, workouts: [workout('w1'), workout('w2'), workout('a-only', '2026-09-26')], _rev: 7 }
const SERVER_B = { ...clone(DEF), _ts: 400, restSec: 30, workouts: [workout('b1', '2026-09-27')], _rev: 21 }
let useStore
const store = () => useStore.getState()

// The store is loaded after the storage each one writes, as a page loaded there sees it: it holds
// that owner (or none) as its own, whatever a test before left behind.
const load = async () => {
  vi.resetModules()
  ;({ useStore } = await import('./useStore.js'))
}
const signedIn = async (uid, S, rev) => {
  localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts, uid }))
  localStorage.setItem('gym_owner', uid)   // as setUser signs in
  await load()
  useStore.setState({ S, user: { id: uid }, ready: true, sync: { offline: false, pending: false, lastSynced: 0 } })
}
const guest = async S => {
  localStorage.removeItem('gym_owner')
  await load()
  useStore.setState({ S, user: null, ready: true })
}
// Another tab of this browser: its sign-out or sign-in writes the owner key first, and this tab's
// storage event for it runs later (useStore's gym_owner listener).
const otherTab = owner => {
  if (owner) localStorage.setItem('gym_owner', owner); else localStorage.removeItem('gym_owner')
}
const ownerEvent = () => window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner' }))
// Another tab signed in as `uid`, and this tab has followed it all the way (followSignIn).
const followed = uid => { otherTab(uid); ownerEvent(); useStore.setState({ user: { id: uid } }) }

// The confirm's answer, for each way into it, asked as Settings does: the import's token first,
// then the check with it. A signed in with a server workout the backup lacks, or a guest with a
// workout on this device the backup lacks.
async function askedAsA() {
  await signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
  const token = store().importToken()
  api.mockResolvedValueOnce({ state: clone(SERVER_A), rev: 7 })
  const c = await store().importConflict(BACKUP, token)
  expect(c).toMatchObject({ workouts: 1, token })
  return { c, token }
}
async function askedAsGuest() {
  await guest({ ...clone(DEF), _ts: 200, workouts: [workout('w1'), workout('guest-only', '2026-09-28')] })
  const token = store().importToken()
  const c = await store().importConflict(BACKUP, token)
  expect(c).toMatchObject({ workouts: 1, device: true, token })
  return { c, token }
}

// What "nothing imported" means: the copy and its saved form stay as they were, and nothing goes
// to the server, not even after the push debounce.
function expectNothingImported(run) {
  const S = store().S
  const saved = localStorage.getItem('gym_state_v1')
  const before = puts().length
  expect(run()).toBe(false)
  expect(store().S).toBe(S)
  expect(localStorage.getItem('gym_state_v1')).toBe(saved)
  vi.advanceTimersByTime(5000)
  expect(puts().length).toBe(before)
}

const CHOICES = [
  ['"Merge them in"', ({ c, token }) => store().importBackup(BACKUP, { mergeWith: c, token })],
  ['"Replace anyway"', ({ token }) => store().importBackup(BACKUP, { mergeWith: null, token })],
]

beforeEach(() => { localStorage.clear(); api.mockReset(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  useStore?.setState({ S: clone(DEF), user: null, ready: false })
})

describe('with no account change, the import goes as before', () => {
  it('"Merge them in" as A', async () => {
    const asked = await askedAsA()
    expect(store().importIsCurrent(asked.token)).toBe(true)
    expect(CHOICES[0][1](asked)).toBe(true)
    expect(ids(store().S.workouts)).toEqual(['w1', 'w2', 'a-only'])
  })

  it('"Replace anyway" as a guest', async () => {
    const asked = await askedAsGuest()
    expect(store().importIsCurrent(asked.token)).toBe(true)
    expect(CHOICES[1][1](asked)).toBe(true)
    expect(ids(store().S.workouts)).toEqual(['w1', 'w2'])
  })
})

describe('the account changes while the import confirm is open', () => {
  for (const [choice, press] of CHOICES) {
    describe(choice, () => {
      it('A → B: refused, whether or not this tab has heard of the switch yet', async () => {
        const asked = await askedAsA()
        otherTab('B')
        expect(store().importIsCurrent(asked.token)).toBe(false)
        expectNothingImported(() => press(asked))

        const asked2 = await askedAsA()
        followed('B')
        expectNothingImported(() => press(asked2))
      })

      it('A → signed out: refused', async () => {
        const asked = await askedAsA()
        otherTab(null)
        expectNothingImported(() => press(asked))

        const asked2 = await askedAsA()
        otherTab(null)
        ownerEvent()
        expect(store().user).toBeNull()
        expectNothingImported(() => press(asked2))
      })

      it('guest → B: refused', async () => {
        const asked = await askedAsGuest()
        otherTab('B')
        expect(store().importIsCurrent(asked.token)).toBe(false)
        expectNothingImported(() => press(asked))

        const asked2 = await askedAsGuest()
        followed('B')
        expectNothingImported(() => press(asked2))
      })
    })
  }

  it('the plain "Import backup?" confirm (no conflict to warn about) is refused the same way', async () => {
    await signedIn('A', clone(DEF), 6)
    const token = store().importToken()
    api.mockResolvedValueOnce({ state: clone(BACKUP), rev: 7 })
    expect(await store().importConflict(BACKUP, token)).toBeNull()
    otherTab('B')
    expect(store().importIsCurrent(token)).toBe(false)
    expectNothingImported(() => store().importBackup(BACKUP, { token }))

    await guest(clone(DEF))
    const token2 = store().importToken()
    expect(await store().importConflict(BACKUP, token2)).toBeNull()
    otherTab('B')
    expectNothingImported(() => store().importBackup(BACKUP, { token: token2 }))
  })

  it('a switch while the check is still asking the server leaves nothing to confirm', async () => {
    await signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
    const token = store().importToken()
    let answer
    api.mockReturnValueOnce(new Promise(r => { answer = r }))
    const asking = store().importConflict(BACKUP, token)
    otherTab('B')
    answer({ state: clone(SERVER_A), rev: 7 })
    expect(await asking).toEqual({ stale: true, token })
    expect(store().importIsCurrent(token)).toBe(false)
    expectNothingImported(() => store().importBackup(BACKUP, { token }))
  })
})

// The Security Analyst's schedules (SEC-01, SEC-02): each import is judged by its own token, never
// by what another import's check left behind, and a check for a stale import asks nothing.
describe('an import is held to the token it began with', () => {
  it('overlapping imports: A\'s, still asking the server, is refused after B\'s confirm is cancelled', async () => {
    await signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
    const tokenA = store().importToken()
    let answerA
    api.mockReturnValueOnce(new Promise(r => { answerA = r }))
    const askingA = store().importConflict(BACKUP, tokenA)

    // Another tab signs in as B; this tab follows. A second import, as B, reads B's server copy,
    // and its confirm is cancelled: B's read is the last one the store holds.
    followed('B')
    useStore.setState({ S: { ...clone(SERVER_B) } })
    const tokenB = store().importToken()
    api.mockResolvedValueOnce({ state: clone(SERVER_B), rev: 21 })
    expect(await store().importConflict(BACKUP, tokenB)).toMatchObject({ token: tokenB })

    answerA({ state: clone(SERVER_A), rev: 7 })
    expect(await askingA).toEqual({ stale: true, token: tokenA })
    expect(store().importIsCurrent(tokenA)).toBe(false)
    // A's plain Import, had its confirm opened: B's read does not make it current.
    expectNothingImported(() => store().importBackup(BACKUP, { token: tokenA }))
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: null, token: tokenA }))
    expect(ids(store().S.workouts)).toEqual(['b1'])
    // B's own import is still B's.
    expect(store().importIsCurrent(tokenB)).toBe(true)
  })

  it('an account switch while the file is still being read: the check asks nothing, the import is refused', async () => {
    await signedIn('A', clone(DEF), 6)
    const token = store().importToken()
    followed('B')   // during readBackupFile
    expect(await store().importConflict(BACKUP, token)).toEqual({ stale: true, token })
    expect(reads()).toHaveLength(0)
    expectNothingImported(() => store().importBackup(BACKUP, { token }))

    await guest(clone(DEF))
    const guestToken = store().importToken()
    otherTab('B')
    expect(await store().importConflict(BACKUP, guestToken)).toEqual({ stale: true, token: guestToken })
    expectNothingImported(() => store().importBackup(BACKUP, { token: guestToken }))
  })

  it('this tab still names A while the owner key says B: no request goes, and A coming back does not revive the import', async () => {
    await signedIn('A', clone(DEF), 6)
    otherTab('B')   // the storage event has not run: user A, owner key B
    const taken = store().importToken()
    expect(taken).toMatchObject({ uid: 'A', owner: 'B' })
    const asked = await store().importConflict(BACKUP)   // no token handed in: one is taken now
    expect(asked.stale).toBe(true)
    expect(reads()).toHaveLength(0)
    otherTab('A')
    expect(store().importIsCurrent(taken)).toBe(false)
    expect(store().importIsCurrent(asked.token)).toBe(false)
    expectNothingImported(() => store().importBackup(BACKUP, { token: taken }))

    // Taken while all agreed, then the owner key moves before the check goes, and back after.
    const token = store().importToken()
    otherTab('B')
    expect(await store().importConflict(BACKUP, token)).toEqual({ stale: true, token })
    expect(reads()).toHaveLength(0)
    otherTab('A')
    expect(store().importIsCurrent(token)).toBe(false)
    expectNothingImported(() => store().importBackup(BACKUP, { token }))
  })

  it('A → B → A while the check is asking the server: the answer is not taken as A\'s', async () => {
    await signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
    const token = store().importToken()
    let answer
    api.mockReturnValueOnce(new Promise(r => { answer = r }))
    const asking = store().importConflict(BACKUP, token)
    followed('B')
    followed('A')
    answer({ state: clone(SERVER_B), rev: 21 })
    expect(await asking).toEqual({ stale: true, token })
    expectNothingImported(() => store().importBackup(BACKUP, { token }))
  })

  it('an import with no token at all writes nothing', async () => {
    await signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
    expectNothingImported(() => store().importBackup(BACKUP))
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: null }))
    // a hand-made answer carries no check's token either
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: { state: clone(SERVER_A), rev: 7 } }))
    await guest({ ...clone(DEF), _ts: 200, workouts: [workout('w1')] })
    expectNothingImported(() => store().importBackup(BACKUP))
  })

  // Same tab, no look at the token in between: nothing but the round trip itself can end it.
  it('A\'s session ends here (a 401) and A signs in again: a token taken before is refused', async () => {
    const { c, token } = await askedAsA()
    store().setUser(null)          // boot's 401: the copy and the owner key stay
    store().setUser({ id: 'A' })   // A signs in again
    expect(store().user?.id).toBe('A')
    expect(localStorage.getItem('gym_owner')).toBe('A')
    expect(store().importIsCurrent(token)).toBe(false)
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: c, token }))
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: null, token }))
  })

  it('A signs out here (clearLocalSession) and signs in again: a token taken before is refused', async () => {
    const { c, token } = await askedAsA()
    api.mockResolvedValue({ ok: true })
    await store().signOut({ force: true })
    expect(localStorage.getItem('gym_owner')).toBeNull()
    store().setUser({ id: 'A' })
    expect(localStorage.getItem('gym_owner')).toBe('A')
    expect(store().importIsCurrent(token)).toBe(false)
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: c, token }))
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: null, token }))
  })

  it('an answer from another import\'s check is refused, and so is a stale one', async () => {
    const asked = await askedAsA()
    const other = store().importToken()
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: asked.c, token: other }))
    expectNothingImported(() => store().importBackup(BACKUP, { mergeWith: { stale: true, token: other }, token: other }))
  })
})

// SEC-02-R1: a tab that slept through another tab's round trip (A signs out and in again, or
// A → B → A) gets the owner events late, with the key already back at A. Each event's own
// before and after ends the imports begun before it; the key now still decides the handoff.
describe('owner events this tab hears of only after the key is back where it was', () => {
  const historical = (oldValue, newValue) =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue, newValue }))
  // This tab's own idea of the owner made the key's (the listener's seenOwner), as after a load.
  const settled = owner => { otherTab(owner); ownerEvent() }

  for (const [label, trip] of [
    ['A → signed out → A', [['A', null], [null, 'A']]],
    ['A → B → A', [['A', 'B'], ['B', 'A']]],
  ]) {
    it(`${label}: the old token is refused, subscribers hear of it, the copy is not handed over`, async () => {
      settled('A')
      const asked = await askedAsA()
      const S = store().S
      const heard = vi.fn(() => store().importIsCurrent(asked.token))   // as Settings' watcher
      const off = useStore.subscribe(heard)
      otherTab('A')   // the key is back at A before any event reaches this tab
      for (const [from, to] of trip) historical(from, to)
      off()
      expect(heard).toHaveBeenCalled()
      expect(heard.mock.results.at(-1).value).toBe(false)
      expect(store().S).toBe(S)              // same owner now: no handoff
      expect(store().user?.id).toBe('A')
      expect(store().importIsCurrent(asked.token)).toBe(false)
      for (const [, press] of CHOICES) expectNothingImported(() => press(asked))
      expectNothingImported(() => store().importBackup(BACKUP, { token: asked.token }))
    })
  }

  it('a check still asking the server across such a round trip comes back stale: no late confirm', async () => {
    settled('A')
    await signedIn('A', { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, 6)
    const token = store().importToken()
    let answer
    api.mockReturnValueOnce(new Promise(r => { answer = r }))
    const asking = store().importConflict(BACKUP, token)
    otherTab('A')
    historical('A', 'B')
    historical('B', 'A')
    answer({ state: clone(SERVER_A), rev: 7 })
    expect(await asking).toEqual({ stale: true, token })
    expectNothingImported(() => store().importBackup(BACKUP, { token }))
  })

  it('guest → A → guest: a guest\'s old token is refused too', async () => {
    settled(null)
    const asked = await askedAsGuest()
    const S = store().S
    const heard = vi.fn(() => store().importIsCurrent(asked.token))
    const off = useStore.subscribe(heard)
    otherTab(null)
    historical(null, 'A')
    historical('A', null)
    off()
    expect(heard.mock.results.at(-1).value).toBe(false)
    expect(store().S).toBe(S)
    expect(store().importIsCurrent(asked.token)).toBe(false)
    for (const [, press] of CHOICES) expectNothingImported(() => press(asked))
  })

  it('an event that changes nothing ends nothing', async () => {
    settled('A')
    const asked = await askedAsA()
    historical('A', 'A')
    expect(store().importIsCurrent(asked.token)).toBe(true)
  })
})
