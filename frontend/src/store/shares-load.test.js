// @vitest-environment happy-dom
// NATG-485: the store loads the share lists itself as soon as sharing is available, so the
// guards on every add-to-routine path read the same answer, not only on the screens that ask.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ config: {}, hold: null }))
vi.mock('../lib/api.js', async orig => ({
  ...(await orig()),
  api: vi.fn(path => {
    if (path === '/api/config') return Promise.resolve(net.config)
    // `hold`: each /api/shares answer waits until the test releases it, as on a slow link.
    if (path === '/api/shares' && net.hold) return new Promise(resolve => net.hold.push(resolve))
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
  net.hold = null
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

  // NATG-493: a sign-in switch while the previous user's request was still out reused that request,
  // which stores nothing when it lands for someone else, so the new user's lists were never asked for.
  it('asks again for the new user when the sign-in changes while the first request is out', async () => {
    net.hold = []
    const out = (id, routineId) => ({ incoming: [], outgoing: [{ id, to: { id: 'u9', name: 'Kim' }, routineId }], etag: id })
    useStore.setState({ user: { id: 'uA', name: 'Alexa' } })
    net.config = { shares: true }
    await useStore.getState().refreshConfig()
    expect(sharesCalls()).toBe(1)
    // Alexa's answer has not come back; Sami signs in.
    useStore.getState().setUser({ id: 'uB', name: 'Sami' })
    expect(sharesCalls()).toBe(2)
    const [alexa, sami] = net.hold
    sami(out('sB', 'rB'))
    await settle()
    expect(useStore.getState().shares).toMatchObject({ uid: 'uB', outgoing: [{ id: 'sB', routineId: 'rB' }] })
    // Alexa's answer arriving late changes nothing for Sami.
    alexa(out('sA', 'rA'))
    await settle()
    expect(useStore.getState().shares).toMatchObject({ uid: 'uB', outgoing: [{ id: 'sB' }] })
    // And a second ask for Sami while nothing is out is answered from what is loaded, not re-sent.
    useStore.getState().sharesIfAvailable()
    expect(sharesCalls()).toBe(2)
  })

  it('still shares one request between callers for the same user', async () => {
    net.hold = []
    useStore.setState({ user: ME, config: { shares: true } })
    const a = useStore.getState().loadShares()
    const b = useStore.getState().loadShares()
    expect(sharesCalls()).toBe(1)
    net.hold[0]({ incoming: [], outgoing: [], etag: 'e' })
    expect(await a).toBe(await b)
  })
})
