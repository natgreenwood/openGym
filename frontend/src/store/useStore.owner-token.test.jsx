// @vitest-environment happy-dom

/* NATG-537: media sync's uploads, downloads and local clean-up outlive awaits the way an import's
   confirm does, and another tab can sign out, switch account or sign in from guest meanwhile. The
   import's token (NATG-535) is now the store's owner token, ownerToken, judged by ownerHolds, and
   media sync takes one per job. It holds for a guest as well as for an account, and stops holding
   the moment another tab writes the owner key, before this tab's storage event for it runs. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(async () => ({})), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { DEF } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
let useStore
const store = () => useStore.getState()

// The store is loaded after the storage each one writes, as a page loaded there sees it.
const load = async () => {
  vi.resetModules()
  ;({ useStore } = await import('./useStore.js'))
}
const signedIn = async uid => {
  localStorage.setItem('gym_owner', uid)
  await load()
  useStore.setState({ S: clone(DEF), user: { id: uid }, ready: true })
}
const guest = async () => {
  localStorage.removeItem('gym_owner')
  await load()
  useStore.setState({ S: clone(DEF), user: null, ready: true })
}
// Another tab of this browser signs in or out: the owner key moves first, the event comes later.
const otherTab = owner => {
  const oldValue = localStorage.getItem('gym_owner')
  if (owner) localStorage.setItem('gym_owner', owner); else localStorage.removeItem('gym_owner')
  return () => window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue, newValue: owner }))
}

describe('ownerToken and ownerHolds', () => {
  it('a guest\'s token holds while nobody signs in, and not after a sign-in here', async () => {
    await guest()
    const token = store().ownerToken()
    expect(token).toMatchObject({ uid: null, owner: null })
    expect(Object.isFrozen(token)).toBe(true)
    expect(store().ownerHolds(token)).toBe(true)
    store().setUser({ id: 'A' })
    expect(store().ownerHolds(token)).toBe(false)
  })

  it('a guest\'s token stops holding once another tab signs in, before this tab has heard', async () => {
    await guest()
    const token = store().ownerToken()
    otherTab('A')
    expect(store().ownerHolds(token)).toBe(false)
  })

  it('an account\'s token stops holding once the owner key moves, while this tab still names it', async () => {
    await signedIn('A')
    const token = store().ownerToken()
    expect(token).toMatchObject({ uid: 'A', owner: 'A' })
    expect(store().ownerHolds(token)).toBe(true)
    const event = otherTab('B')
    expect(store().user).toEqual({ id: 'A' })
    expect(store().ownerHolds(token)).toBe(false)
    event()
    expect(store().ownerHolds(token)).toBe(false)
  })

  it('does not hold again after a round trip back to the same account', async () => {
    await signedIn('A')
    const token = store().ownerToken()
    otherTab('B')()
    otherTab('A')()
    useStore.setState({ user: { id: 'A' } })
    expect(localStorage.getItem('gym_owner')).toBe('A')
    expect(store().ownerHolds(token)).toBe(false)
    expect(store().ownerHolds(store().ownerToken())).toBe(true)
  })

  it('holds nothing without a token, and an import\'s token is one of these', async () => {
    await signedIn('A')
    expect(store().ownerHolds(null)).toBe(false)
    const token = store().importToken()
    expect(token).toMatchObject({ uid: 'A', owner: 'A' })
    expect(store().ownerHolds(token)).toBe(true)
    expect(store().importIsCurrent(token)).toBe(true)
    otherTab('B')
    expect(store().importIsCurrent(token)).toBe(false)
  })
})
