// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { freshStore, releaseStores } from './fresh-store.js'

vi.mock('../lib/api.js', () => ({ api: vi.fn(async () => { throw new TypeError('Failed to fetch') }), setRemoteAuth: vi.fn() }))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn(), stopRest: vi.fn(), abandonWork: vi.fn() }) } }))

// Another tab signing in as `to`: what the gym_owner 'storage' listener of every loaded store hears.
const ownerMoves = to => {
  const from = localStorage.getItem('gym_owner')
  localStorage.setItem('gym_owner', to)
  window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: from, newValue: to }))
}

describe('freshStore', () => {
  it('loads a new store each time, and its clean-up signs it out and takes its listeners off', async () => {
    localStorage.setItem('gym_owner', 'u1')
    const { useStore: first } = await freshStore()
    const { useStore: second } = await freshStore()
    expect(second).not.toBe(first)
    first.setState({ user: { id: 'u1' }, ready: true })

    // Loaded and not yet released, a store hears another tab's owner change and hands its copy over.
    const before = first.getState()
    ownerMoves('u2')
    expect(first.getState()).not.toBe(before)
    expect(first.getState().user).toBeNull()

    first.setState({ user: { id: 'u2' }, ready: true })
    releaseStores()
    expect(first.getState()).toMatchObject({ user: null, ready: false })
    expect(second.getState()).toMatchObject({ user: null, ready: false })

    // Released, neither store hears it any more.
    const kept = [first.getState(), second.getState()]
    ownerMoves('u3')
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    expect(first.getState()).toBe(kept[0])
    expect(second.getState()).toBe(kept[1])
    localStorage.clear()
  })

  it('puts addEventListener back as it found it', async () => {
    const add = window.addEventListener
    const own = Object.hasOwn(window, 'addEventListener')
    await freshStore()
    expect(window.addEventListener).toBe(add)
    expect(Object.hasOwn(window, 'addEventListener')).toBe(own)
  })
})
