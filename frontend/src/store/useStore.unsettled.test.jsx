// @vitest-environment happy-dom
// NATG-670: `sync.unsettled`, whether this device has made an edit whose effect on the share
// lists it hasn't heard yet. The routine page measures a shared routine itself while it is on,
// because the server's `too-large` flag may still be its verdict on an older copy. On with an
// edit; off once the push carrying it has landed and the lists have been heard from since, by a
// fresh GET /api/shares or by a revision poll whose etag hasn't moved. A failed push leaves it on.
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn(), stopRest: vi.fn(), abandonWork: vi.fn(), closeAll: vi.fn(), dismissToast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF, useStore } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const USER = { id: 'u1', name: 'Sam' }
const fresh = { offline: false, pending: false, unsettled: false, auth: false, lastError: null, lastSynced: 0, server: null }
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
const unsettled = () => useStore.getState().sync.unsettled

// `net.down`: PUT /api/data fails as with no network. `net.holdShares`: each GET /api/shares
// waits for the test to answer it (`answers`).
let net, answers
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('gym_owner', USER.id); api.mockReset()
  net = { rev: 1, etag: 'e1', down: false, holdShares: false }
  answers = []
  useStore.setState({ S: clone(DEF), user: null, ready: false, sync: { ...fresh }, config: null, shares: null, sharesError: false })
  api.mockImplementation(async (path, o = {}) => {
    const method = o.method || 'GET'
    const lists = () => ({ incoming: [], outgoing: [], etag: net.etag })
    if (path === '/api/shares') return net.holdShares ? new Promise(resolve => answers.push(() => resolve(lists()))) : lists()
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path === '/api/data' && method === 'PUT') {
      if (net.down) throw Object.assign(new TypeError('Failed to fetch'), { status: undefined })
      return { ok: true, rev: ++net.rev }
    }
    if (path === '/api/data') return { state: clone(useStore.getState().S), rev: net.rev }
    return {}
  })
})
// Signed in, in step with the server, the lists loaded once.
const signedIn = async () => {
  const S = clone(DEF)
  useStore.setState({ S, user: USER, ready: true, sync: { ...fresh }, config: { shares: true } })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: net.rev, ts: S._ts || 0, uid: USER.id }))
  await useStore.getState().loadShares()
}
// An edit, pushed now rather than after the debounce.
const edit = () => useStore.getState().update(s => { s.routines = [...(s.routines || []), { id: 'r' + Date.now(), name: 'Push', ex: [] }] })
const push = () => useStore.getState().pushState()
const poll = async () => { window.dispatchEvent(new Event('online')); await tick() }

it('is off while nothing was edited, and on as soon as an edit queues a push', async () => {
  await signedIn()
  expect(unsettled()).toBe(false)
  edit()
  expect(unsettled()).toBe(true)
})

it('stays on when the push lands, and goes off with a share list requested after it', async () => {
  await signedIn()
  edit()
  await push()
  expect(useStore.getState().sync.pending).toBe(false)
  expect(unsettled()).toBe(true)   // landed, but the lists held here predate it
  await useStore.getState().loadShares()
  expect(unsettled()).toBe(false)
})

it('a share list requested before the push landed does not settle it', async () => {
  await signedIn()
  net.holdShares = true
  const early = useStore.getState().loadShares()
  edit()
  await push()
  answers[0]()
  await early
  expect(unsettled()).toBe(true)
})

it('goes off at the next revision poll when the lists etag has not moved', async () => {
  await signedIn()
  edit()
  await push()
  expect(unsettled()).toBe(true)
  await poll()
  expect(api.mock.calls.filter(c => c[0] === '/api/shares')).toHaveLength(1)   // no request of its own
  expect(unsettled()).toBe(false)
})

it('a poll whose etag moved settles it through the list it loads', async () => {
  await signedIn()
  edit()
  await push()
  net.etag = 'e2'   // the push moved a verdict
  await poll()
  expect(useStore.getState().shares.etag).toBe('e2')
  expect(unsettled()).toBe(false)
})

it('stays on after a push that failed, whatever the lists say', async () => {
  await signedIn()
  net.down = true
  edit()
  await push()
  expect(useStore.getState().sync.pending).toBe(true)
  await useStore.getState().loadShares()
  expect(unsettled()).toBe(true)
  // Back online: the owed copy goes, and then the lists are heard from again.
  net.down = false
  await poll()
  await poll()
  expect(unsettled()).toBe(false)
})

it('an edit made while a push is out keeps it on until a push carrying that edit has landed', async () => {
  await signedIn()
  edit()
  const first = push()
  edit()   // queues its own push, after the debounce
  await first
  await useStore.getState().loadShares()
  expect(unsettled()).toBe(true)
  await push()
  await useStore.getState().loadShares()
  expect(unsettled()).toBe(false)
})
