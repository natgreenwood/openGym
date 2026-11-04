// @vitest-environment happy-dom
// NATG-502: a share-list request already in flight is stale only when it can't be as new as what
// its caller knew of. A revision poll that saw the etag the request will answer starts no extra
// request; Accept, Decline and Remove reload from a request that left after their answer; and a
// revoke that a stale answer saw first is still told, once.
import { beforeEach, expect, it, vi } from 'vitest'

const ui = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: ui.toast, stopRest: vi.fn(), abandonWork: vi.fn(), closeAll: vi.fn(), dismissToast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF, useStore } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const USER = { id: 'u2', name: 'Jo' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
const LEG = { id: 'r9', name: 'Leg Day', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }] }
const share = (id, state = 'accepted') => ({ id, state, from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h' + id, routine: LEG })
const lists = (incoming, etag) => ({ incoming: clone(incoming), outgoing: [], etag })

// `net.hold`: while set, each GET /api/shares waits for the test to answer it (`answers`), so a
// request can be kept in flight; otherwise it answers what the server has now.
let net, answers
const loads = () => api.mock.calls.filter(c => c[0] === '/api/shares').length
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('gym_owner', USER.id); api.mockReset(); ui.toast.mockReset()
  net = { incoming: [share('s1')], etag: 'e1', rev: 1, hold: false }
  answers = []
  useStore.setState({ S: clone(DEF), user: null, ready: false, sync: { ...fresh }, config: null, shares: null, sharesError: false })
  api.mockImplementation(async (path, o = {}) => {
    const method = o.method || 'GET'
    if (path === '/api/shares') return net.hold ? new Promise(resolve => answers.push(resolve)) : lists(net.incoming, net.etag)
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path.endsWith('/accept')) { net.incoming = net.incoming.map(i => path.includes(i.id) ? { ...i, state: 'accepted' } : i); net.etag = 'e-accept'; return { ok: true } }
    if (path.endsWith('/decline')) { net.incoming = net.incoming.filter(i => !path.includes(i.id)); net.etag = 'e-decline'; return { ok: true } }
    if (path.startsWith('/api/shares/') && method === 'DELETE') { net.incoming = net.incoming.filter(i => !path.endsWith(i.id)); net.etag = 'e-remove'; return { ok: true } }
    if (path === '/api/data' && method === 'PUT') return { ok: true, rev: ++net.rev }
    if (path === '/api/data') return { state: clone(useStore.getState().S), rev: net.rev }
    return {}
  })
})
// Signed in with nothing owed to the server, so a poll checks the revision (and the `shares` etag)
// rather than pushing first.
const signedIn = async (S = clone(DEF)) => {
  useStore.setState({ S, user: USER, ready: true, sync: { ...fresh }, config: { shares: true } })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: net.rev, ts: S._ts || 0 }))
  await useStore.getState().pushState()
}
// A revision poll, as coming back online starts one.
const poll = async () => { window.dispatchEvent(new Event('online')); await tick() }

it('AC1: a poll that saw the etag the fresh request will answer starts no extra request, and the sweep runs when it lands', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  // A request is out, Sync now marks it stale, and its answer lands: the fresh one goes out.
  net.hold = true
  const older = useStore.getState().loadShares()
  useStore.getState().loadSharesNewer()
  answers[0](lists([share('s1')], 'e1'))
  await older
  await tick(0)
  expect(answers).toHaveLength(2)
  // The share is revoked; every poll while the fresh request is out sees the etag it will answer.
  net.incoming = []; net.etag = 'e2'
  await poll()
  await poll()
  answers[1](lists([], 'e2'))
  await tick()
  expect(answers).toHaveLength(2)
  expect(loads()).toBe(3)
  // It was as new as anything a caller knew of: it swept, and said so once.
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
})

it('AC1: a poll that saw a different etag from the one the request answers still loads again', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  net.hold = true
  const out = useStore.getState().loadShares()
  net.etag = 'e2'
  await poll()
  answers[0](lists([share('s1')], 'e1'))
  await out
  await tick(0)
  expect(answers).toHaveLength(2)
  answers[1](lists([share('s1')], 'e2'))
  await tick()
})

it('AC2: an Accept made while an older request is in flight does not show the share as pending once it resolves', async () => {
  net.incoming = [share('s1', 'pending')]
  await signedIn()
  await useStore.getState().loadShares()
  net.hold = true
  useStore.getState().loadShares()
  const accepting = useStore.getState().acceptShare('s1')
  await tick(0)
  answers[0](lists([share('s1', 'pending')], 'e1'))
  await tick(0)
  expect(answers).toHaveLength(2)
  answers[1](lists(net.incoming, net.etag))
  await accepting
  expect(useStore.getState().shares.incoming[0].state).toBe('accepted')
})

it('AC2: a Decline made while an older request is in flight does not leave the share listed once it resolves', async () => {
  net.incoming = [share('s1', 'pending')]
  await signedIn()
  await useStore.getState().loadShares()
  net.hold = true
  useStore.getState().loadShares()
  const declining = useStore.getState().declineShare('s1')
  await tick(0)
  answers[0](lists([share('s1', 'pending')], 'e1'))
  await tick(0)
  answers[1](lists(net.incoming, net.etag))
  await declining
  expect(useStore.getState().shares.incoming).toEqual([])
})

it('AC2: a Remove made while an older request is in flight is not undone by that request, and is not told as a revoke', async () => {
  await signedIn({ ...clone(DEF), week: { 2: ['shared:s1'] } })
  await useStore.getState().loadShares()
  net.hold = true
  useStore.getState().loadShares()
  await useStore.getState().removeShare('s1')
  answers[0](lists([share('s1')], 'e1'))
  await tick(0)
  expect(answers).toHaveLength(2)
  answers[1](lists(net.incoming, net.etag))
  await tick()
  expect(useStore.getState().shares.incoming).toEqual([])
  expect(useStore.getState().S.week[2]).toBeUndefined()
  expect(ui.toast).not.toHaveBeenCalled()
})

it('AC2: a Remove made after a stale answer was stored is not told as a revoke by the next load', async () => {
  await signedIn({ ...clone(DEF), week: { 2: ['shared:s1'] } })
  await useStore.getState().loadShares()
  net.hold = true
  useStore.getState().loadShares()
  useStore.getState().loadSharesNewer()
  answers[0](lists([share('s1')], 'e1'))
  await tick(0)
  // The fresh request is out when the user removes the share: it is stale too, and the one after
  // it lands without the share.
  await useStore.getState().removeShare('s1')
  answers[1](lists([share('s1')], 'e1'))
  await tick(0)
  answers[2](lists(net.incoming, net.etag))
  await tick()
  expect(useStore.getState().shares.incoming).toEqual([])
  expect(ui.toast).not.toHaveBeenCalled()
})

it('AC3: a revoke that a stale request sees first is still told, once', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'], 3: ['shared:s1'] } })
  await useStore.getState().loadShares()
  net.hold = true
  const older = useStore.getState().loadShares()
  net.incoming = []; net.etag = 'e2'
  // Sync now: no etag, so the request in flight is stale whatever it answers.
  useStore.getState().loadSharesNewer()
  answers[0](lists([], 'e2'))
  await older
  await tick(0)
  expect(ui.toast).not.toHaveBeenCalled()
  expect(useStore.getState().S.week[1]).toEqual(['shared:s1'])
  answers[1](lists([], 'e2'))
  await tick()
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(useStore.getState().S.week[3]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
  // The load after it is no news.
  net.hold = false
  await useStore.getState().loadShares()
  await tick()
  expect(ui.toast).toHaveBeenCalledTimes(1)
})

it('NATG-510: a Remove whose DELETE is answered after a sign-out does not throw', async () => {
  await signedIn({ ...clone(DEF), week: { 2: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const real = api.getMockImplementation()
  let done
  api.mockImplementation((path, o = {}) => o.method === 'DELETE' ? new Promise(resolve => { done = resolve }) : real(path, o))
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  useStore.setState({ user: null, shares: null })
  done({ ok: true })
  await expect(removing).resolves.toBe(true)
  expect(ui.toast).not.toHaveBeenCalled()
})
