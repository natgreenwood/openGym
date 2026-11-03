// @vitest-environment happy-dom
// NATG-485: the store loads the share lists itself as soon as sharing is available, so the
// guards on every add-to-routine path read the same answer, not only on the screens that ask.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ config: {} }))
vi.mock('../lib/api.js', async orig => ({
  ...(await orig()),
  api: vi.fn(path => {
    if (path === '/api/config') return Promise.resolve(net.config)
    if (path === '/api/shares') return Promise.resolve({ incoming: [], outgoing: [{ id: 's1', to: { id: 'u2', name: 'Jo' }, routineId: 'r1' }], etag: 'e' })
    return Promise.resolve({})
  })
}))

import { useStore } from './useStore.js'
import { api } from '../lib/api.js'

const ME = { id: 'u1', name: 'Sam' }
const sharesCalls = () => api.mock.calls.filter(([p]) => p === '/api/shares').length
const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useStore.setState({ user: null, config: null, shares: null, sharesError: false })
})

describe('store: share lists load once sharing is available', () => {
  it('loads them when a config that says `shares` arrives for a signed-in user, and only once', async () => {
    useStore.setState({ user: ME })
    net.config = { shares: true }
    await useStore.getState().refreshConfig()
    await settle()
    expect(sharesCalls()).toBe(1)
    expect(useStore.getState().shares).toMatchObject({ uid: 'u1', outgoing: [{ id: 's1' }] })
    await useStore.getState().refreshConfig()
    await settle()
    expect(sharesCalls()).toBe(1)
  })

  it('loads them on sign-in when the config already says `shares`', async () => {
    useStore.setState({ config: { shares: true } })
    useStore.getState().setUser(ME)
    await settle()
    expect(sharesCalls()).toBe(1)
  })

  it('asks nothing while sharing is off, or with nobody signed in', async () => {
    useStore.setState({ user: ME })
    net.config = {}
    await useStore.getState().refreshConfig()
    useStore.setState({ user: null })
    net.config = { shares: true }
    await useStore.getState().refreshConfig()
    await settle()
    expect(sharesCalls()).toBe(0)
  })
})
