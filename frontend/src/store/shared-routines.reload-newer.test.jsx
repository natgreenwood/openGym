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

it('NATG-511: when the fresh request after a stale answer fails, the next poll loads again, and the sweep and toast run once', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const real = api.getMockImplementation()
  const pending = []
  api.mockImplementation((path, o = {}) => path === '/api/shares' && pending.length < 2
    ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
    : real(path, o))
  const older = useStore.getState().loadShares()
  useStore.getState().loadSharesNewer()
  // The server revokes the share; the stale answer sees it and is stored, and the fresh one fails.
  net.incoming = []; net.etag = 'e2'
  pending[0].resolve(lists([], 'e2'))
  await older
  await tick(0)
  expect(pending).toHaveLength(2)
  pending[1].reject(Object.assign(new Error('offline'), { status: 0 }))
  await tick()
  expect(useStore.getState().sharesError).toBe(true)
  expect(useStore.getState().S.week[1]).toEqual(['shared:s1'])
  expect(ui.toast).not.toHaveBeenCalled()
  // The next poll sees the etag the stale answer stored, and still loads again.
  const before = loads()
  await poll()
  expect(loads()).toBe(before + 1)
  expect(useStore.getState().sharesError).toBe(false)
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
  // And only once: the poll after it has nothing to load.
  await poll()
  expect(loads()).toBe(before + 1)
  expect(ui.toast).toHaveBeenCalledTimes(1)
})

it('a share first listed by a stale answer keeps its name when the fresh answer says it is not available', async () => {
  net.incoming = []
  await signedIn()
  await useStore.getState().loadShares()
  net.hold = true
  const older = useStore.getState().loadShares()
  useStore.getState().loadSharesNewer()
  answers[0](lists([share('s1')], 'e2'))
  await older
  await tick(0)
  answers[1](lists([{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unavailable: 'custom-exercise' }], 'e3'))
  await tick()
  expect(useStore.getState().shares.names.s1).toBe('Leg Day')
})

// NATG-512: a share the user is removing is never told as revoked, even when a load the server
// answered after applying the DELETE lands before removeShare has its response.
// The DELETE is applied on the server at once and answered when the test says (`answer`).
const holdDelete = (outcome = 'ok') => {
  const real = api.getMockImplementation()
  const held = {}
  api.mockImplementation((path, o = {}) => {
    if (o.method !== 'DELETE') return real(path, o)
    if (outcome !== 'unapplied') { net.incoming = net.incoming.filter(i => !path.endsWith(i.id)); net.etag = 'e-remove' }
    return new Promise((resolve, reject) => { held.answer = () => outcome === 'ok' ? resolve({ ok: true }) : reject(Object.assign(new Error('server'), { status: 500 })) })
  })
  return held
}
const PUSH = { id: 'r8', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }

it('NATG-512 AC1: a load that lands before the DELETE response does not tell the removed share as revoked', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const del = holdDelete()
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  await useStore.getState().loadShares()
  await tick()
  expect(useStore.getState().S.week[1]).toBeUndefined()
  del.answer()
  await expect(removing).resolves.toBe(true)
  await tick()
  expect(useStore.getState().shares.incoming).toEqual([])
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-512 AC2: another share revoked by its owner during the Remove is still told, once', async () => {
  net.incoming = [share('s1'), { ...share('s2'), routine: PUSH }]
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'], 2: ['shared:s2'] } })
  await useStore.getState().loadShares()
  const del = holdDelete()
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  // The owner of s2 revokes it while the DELETE is out.
  net.incoming = net.incoming.filter(i => i.id !== 's2')
  await useStore.getState().loadShares()
  await tick()
  del.answer()
  await removing
  await tick()
  expect(useStore.getState().S.week[2]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Push Day is no longer shared with you. It’s off your schedule too.')
})

it('NATG-512 AC3: a DELETE the server applied but whose answer failed still throws, and its reload does not tell the share as revoked', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const del = holdDelete('applied-then-failed')
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  del.answer()
  await expect(removing).rejects.toThrow('server')
  await tick()
  expect(useStore.getState().shares.incoming).toEqual([])
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-512 AC3: after a failed Remove has reloaded, a revoke of the same share is told as usual', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const del = holdDelete('unapplied')
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  del.answer()
  await expect(removing).rejects.toThrow('server')
  await tick()
  expect(useStore.getState().shares.incoming.map(i => i.id)).toEqual(['s1'])
  expect(ui.toast).not.toHaveBeenCalled()
  // Later, its owner revokes it.
  net.incoming = []; net.etag = 'e2'
  await useStore.getState().loadShares()
  await tick()
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
})

it('NATG-512 AC4: the mark is per user: the account signed in next during the Remove is still told of its revokes, and nothing throws', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const del = holdDelete('unapplied')
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  // Another account signs in while the DELETE is out, and holds a share with the same id.
  useStore.setState({ user: null, shares: null })
  localStorage.setItem('gym_owner', 'u3')
  useStore.setState({ S: { ...clone(DEF), week: { 4: ['shared:s1'] } }, user: { id: 'u3', name: 'Al' }, shares: null })
  await useStore.getState().loadShares()
  net.incoming = []; net.etag = 'e3'
  await useStore.getState().loadShares()
  await tick()
  expect(useStore.getState().S.week[4]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
  del.answer()
  await expect(removing).rejects.toThrow('server')
  await tick()
  expect(ui.toast).toHaveBeenCalledTimes(1)
})

it('NATG-512: a Remove made while nobody is signed in, with no mark held, leaves no unhandled rejection, whether the DELETE succeeds or is refused', async () => {
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    useStore.setState({ user: null, shares: null, ready: true })
    await expect(useStore.getState().removeShare('s1')).resolves.toBe(true)
    await tick()
    const real = api.getMockImplementation()
    api.mockImplementation((path, o = {}) => o.method === 'DELETE'
      ? Promise.reject(Object.assign(new Error('Sign in again'), { status: 401 }))
      : real(path, o))
    await expect(useStore.getState().removeShare('s1')).rejects.toThrow('Sign in again')
    await tick()
  } finally { process.off('unhandledRejection', onUnhandled) }
  expect(unhandled).toEqual([])
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-512: a Remove whose local steps throw after the DELETE still reloads and clears the mark, so a later revoke is told', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  // The DELETE is answered but, as far as the lists show, the share is still there.
  const real = api.getMockImplementation()
  api.mockImplementation((path, o = {}) => o.method === 'DELETE' ? Promise.resolve({ ok: true }) : real(path, o))
  const update = useStore.getState().update
  useStore.setState({ update: () => { throw new Error('local step failed') } })
  try {
    await expect(useStore.getState().removeShare('s1')).rejects.toThrow('local step failed')
  } finally { useStore.setState({ update }) }
  await tick()
  expect(useStore.getState().shares.incoming.map(i => i.id)).toEqual(['s1'])
  net.incoming = []; net.etag = 'e2'
  await useStore.getState().loadShares()
  await tick()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
})

// Each DELETE is held until the test answers it, in the order they were sent, and applies nothing
// on the server by itself.
const heldDeletes = () => {
  const real = api.getMockImplementation()
  const held = []
  api.mockImplementation((path, o = {}) => o.method === 'DELETE' ? new Promise((resolve, reject) => held.push({ resolve, reject })) : real(path, o))
  return held
}

it('NATG-521: a retried Remove stays marked when the failed attempt\'s reload settles first', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const held = heldDeletes()
  net.hold = true
  // The first attempt fails without being applied; its reload is still out when the user retries.
  const first = useStore.getState().removeShare('s1')
  const failed = expect(first).rejects.toThrow('server')
  held[0].reject(Object.assign(new Error('server'), { status: 500 }))
  await failed
  expect(answers).toHaveLength(1)
  const retry = useStore.getState().removeShare('s1')
  answers[0](lists([share('s1')], 'e1'))
  await tick()
  // The retry's DELETE is applied on the server; a load lands before its answer.
  net.hold = false; net.incoming = []; net.etag = 'e2'
  await useStore.getState().loadShares()
  await tick()
  expect(ui.toast).not.toHaveBeenCalled()
  held[1].resolve({ ok: true })
  await expect(retry).resolves.toBe(true)
  await tick()
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-523: a Remove in another account does not drop the first account\'s mark (A to B to A)', async () => {
  const S = { ...clone(DEF), week: { 1: ['shared:s1'] } }
  await signedIn(S)
  await useStore.getState().loadShares()
  const held = heldDeletes()
  const a = useStore.getState().removeShare('s1')
  await useStore.getState().signOut({ force: true })
  // Account B signs in and removes a share of its own while A's DELETE is still out.
  localStorage.setItem('gym_owner', 'u3')
  useStore.setState({ S: { ...clone(DEF), week: { 2: ['shared:s2'] } }, user: { id: 'u3', name: 'Al' }, shares: null })
  net.incoming = [{ ...share('s2'), routine: PUSH }]; net.etag = 'b1'
  await useStore.getState().loadShares()
  const b = useStore.getState().removeShare('s2')
  await useStore.getState().signOut({ force: true })
  // A comes back and loads s1 before its DELETE is applied; then it is applied, and a load lands
  // before either DELETE is answered.
  localStorage.setItem('gym_owner', USER.id)
  net.incoming = [share('s1')]; net.etag = 'a1'
  await signedIn(S)
  await useStore.getState().loadShares()
  net.incoming = []; net.etag = 'a2'
  await useStore.getState().loadShares()
  await tick()
  expect(ui.toast).not.toHaveBeenCalled()
  held[0].resolve({ ok: true })
  held[1].resolve({ ok: true })
  await expect(a).resolves.toBe(true)
  await expect(b).resolves.toBe(true)
  await tick()
  expect(ui.toast).not.toHaveBeenCalled()
})

// NATG-531: A removes a share, signs out, and B signs in before the DELETE is answered. The answer
// is A's: B's lists and copy are left as they are (no stamp, no push), and A's pointer is swept on
// A's next load without telling the removal as a revoke.
const PUTS = () => api.mock.calls.filter(c => c[0] === '/api/data' && c[1]?.method === 'PUT').length
const B = { id: 'u3', name: 'Al' }
const removeThenSwitch = async () => {
  const SA = { ...clone(DEF), week: { 1: ['shared:s1'] } }
  await signedIn(SA)
  await useStore.getState().loadShares()
  const del = holdDelete()
  const removing = useStore.getState().removeShare('s1')
  await tick(0)
  await useStore.getState().signOut({ force: true })
  // B signs in, with a share of its own and a plan day that points at it.
  localStorage.setItem('gym_owner', B.id)
  net.incoming = [{ ...share('s2'), routine: PUSH }]; net.etag = 'b1'
  const SB = { ...clone(DEF), _ts: 1000, week: { 2: ['shared:s2'] } }
  useStore.setState({ S: SB, user: B, ready: true, sync: { ...fresh }, config: { shares: true }, shares: null })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: net.rev, ts: SB._ts }))
  await useStore.getState().pushState()
  await useStore.getState().loadShares()
  await tick()
  return { SA, del, removing }
}

it('NATG-531 AC1: a Remove answered after a switch to another account leaves that account\'s copy, stamp and lists alone, and pushes nothing', async () => {
  const { del, removing } = await removeThenSwitch()
  const S = useStore.getState().S
  const ts = S._ts
  const saved = localStorage.getItem('gym_state_v1')
  // The reload after the DELETE still runs, as B, so B's lists are saved again: the same lists,
  // fetched later.
  const listsOf = v => v && { ...v, fetchedAt: 0 }
  const shares = listsOf(useStore.getState().shares)
  const savedShares = listsOf(JSON.parse(localStorage.getItem('gym_shared_v1')))
  const puts = PUTS()
  del.answer()
  await expect(removing).resolves.toBe(true)
  // Past the push debounce (1.5 s): a change stamped by the Remove would have been PUT by now.
  await tick(1700)
  expect(useStore.getState().S).toBe(S)
  expect(useStore.getState().S._ts).toBe(ts)
  expect(useStore.getState().S.week[2]).toEqual(['shared:s2'])
  expect(localStorage.getItem('gym_state_v1')).toBe(saved)
  expect(PUTS()).toBe(puts)
  expect(shares.uid).toBe(B.id)
  expect(listsOf(useStore.getState().shares)).toEqual(shares)
  expect(listsOf(JSON.parse(localStorage.getItem('gym_shared_v1')))).toEqual(savedShares)
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-531 AC2: on A\'s next load after the switch, A\'s pointer to the removed share is swept, and no revoke is told', async () => {
  const { SA, del, removing } = await removeThenSwitch()
  del.answer()
  await expect(removing).resolves.toBe(true)
  await tick()
  await useStore.getState().signOut({ force: true })
  // A signs back in: its copy still points at s1, which the server no longer lists.
  localStorage.setItem('gym_owner', USER.id)
  net.incoming = []; net.etag = 'a2'
  await signedIn(SA)
  expect(useStore.getState().S.week[1]).toEqual(['shared:s1'])
  await useStore.getState().loadShares()
  await tick()
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(ui.toast).not.toHaveBeenCalled()
})

// NATG-522: a Remove's reload settles only once the latest request for the user has swept, so its
// mark outlasts a follow-up that another refresh makes stale again. Here the DELETE is applied on
// the server but its answer fails, while an older request is out.
const serverError = () => Object.assign(new Error('server'), { status: 500 })
const OTHER = id => ({ ...share(id), routine: PUSH })
const failedRemoveBehindOlderLoad = async (incoming = [share('s1')], week = { 1: ['shared:s1'] }) => {
  net.incoming = incoming
  await signedIn({ ...clone(DEF), week })
  await useStore.getState().loadShares()
  const held = heldDeletes()
  net.hold = true
  const older = useStore.getState().loadShares()
  const removing = useStore.getState().removeShare('s1')
  const failed = expect(removing).rejects.toThrow('server')
  // Applied on the server, answered with an error.
  net.incoming = net.incoming.filter(i => i.id !== 's1'); net.etag = 'e2'
  held[0].reject(serverError())
  await failed
  // The older request, stale since the Remove joined it, lands with s1 and starts the next one.
  answers[0](lists(incoming, 'e1'))
  await older
  await tick(0)
  expect(answers).toHaveLength(2)
  return held
}

it('NATG-522 AC1: Sync now making the Remove\'s follow-up stale does not tell the removed share as revoked', async () => {
  await failedRemoveBehindOlderLoad()
  const synced = useStore.getState().loadSharesNewer()
  answers[1](lists([], 'e2'))
  await tick(0)
  expect(answers).toHaveLength(3)
  answers[2](lists([], 'e2'))
  await synced
  await tick()
  expect(useStore.getState().shares.incoming).toEqual([])
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-522 AC1: a second Remove making the first one\'s follow-up stale tells neither share as revoked', async () => {
  const held = await failedRemoveBehindOlderLoad([share('s1'), OTHER('s2')], { 1: ['shared:s1'], 2: ['shared:s2'] })
  const second = useStore.getState().removeShare('s2')
  net.incoming = []; net.etag = 'e3'
  held[1].resolve({ ok: true })
  await expect(second).resolves.toBe(true)
  answers[1](lists([OTHER('s2')], 'e2'))
  await tick(0)
  expect(answers).toHaveLength(3)
  answers[2](lists([], 'e3'))
  await tick()
  expect(useStore.getState().shares.incoming).toEqual([])
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(useStore.getState().S.week[2]).toBeUndefined()
  expect(ui.toast).not.toHaveBeenCalled()
})

it('NATG-522 AC2: in the same chain, a share its owner revokes is still told, once', async () => {
  await failedRemoveBehindOlderLoad([share('s1'), OTHER('s2')], { 1: ['shared:s1'], 2: ['shared:s2'] })
  // The owner of s2 revokes it while the follow-up is out, and Sync now makes that one stale.
  net.incoming = []; net.etag = 'e3'
  const synced = useStore.getState().loadSharesNewer()
  answers[1](lists([OTHER('s2')], 'e2'))
  await tick(0)
  expect(answers).toHaveLength(3)
  answers[2](lists([], 'e3'))
  await synced
  await tick()
  expect(useStore.getState().S.week[2]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Push Day is no longer shared with you. It’s off your schedule too.')
})

it('NATG-522 AC2: once every reload in the chain has settled after a failed Remove the server did not apply, a revoke of that share is told', async () => {
  await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
  await useStore.getState().loadShares()
  const held = heldDeletes()
  net.hold = true
  const older = useStore.getState().loadShares()
  const removing = useStore.getState().removeShare('s1')
  const failed = expect(removing).rejects.toThrow('server')
  held[0].reject(serverError())
  await failed
  answers[0](lists([share('s1')], 'e1'))
  await older
  await tick(0)
  const synced = useStore.getState().loadSharesNewer()
  answers[1](lists([share('s1')], 'e1'))
  await tick(0)
  expect(answers).toHaveLength(3)
  answers[2](lists([share('s1')], 'e1'))
  await synced
  await tick()
  expect(useStore.getState().shares.incoming.map(i => i.id)).toEqual(['s1'])
  expect(ui.toast).not.toHaveBeenCalled()
  // Later, its owner revokes it.
  net.hold = false; net.incoming = []; net.etag = 'e2'
  await useStore.getState().loadShares()
  await tick()
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(ui.toast).toHaveBeenCalledTimes(1)
  expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
})

it('NATG-522 AC3: with every follow-up made stale, loadSharesNewer still settles after a bounded number of them, and nothing is left unhandled', async () => {
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    await signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
    await useStore.getState().loadShares()
    net.hold = true
    let settled = false
    const first = useStore.getState().loadSharesNewer().then(v => { settled = true; return v })
    const later = []
    // Each request is made stale (Sync now) before it lands, so each landing starts another.
    let n = 0
    while (!settled && n < 20) {
      later.push(useStore.getState().loadSharesNewer())
      answers[n](lists([share('s1')], 'e1'))
      n++
      await tick(0)
    }
    expect(settled).toBe(true)
    // It gave up waiting with a request still out: the one it joined plus a few follow-ups.
    expect(n).toBeGreaterThan(1)
    expect(n).toBeLessThan(20)
    expect(answers).toHaveLength(n + 1)
    await expect(first).resolves.toMatchObject({ uid: USER.id })
    // The refreshes stop; the request still out lands, and every caller settles.
    net.hold = false
    answers[n](lists([share('s1')], 'e1'))
    await Promise.all(later)
    await tick()
  } finally { process.off('unhandledRejection', onUnhandled) }
  expect(unhandled).toEqual([])
  expect(ui.toast).not.toHaveBeenCalled()
})
