// @vitest-environment happy-dom

/* A second tab of the same browser while the owner of the copy changes in the first (QA round 2,
   2026-10-06). The sign-out wrote its wiped copy while the owner key still named the account, so
   the idle tab joined its whole copy of the account into it: the next guest saw it, and the next
   profile created there uploaded it. A device-link sign-in to another account did the same. And a
   guest tab left open put its workout, routine and default settings into the account after "Keep
   profile as is". Each "tab" is a fresh import of the store sharing one localStorage; the browser's
   storage events are replayed in the order the writes happened, as the browser delivers them. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshStore } from '../test-utils/fresh-store.js'
import { localTZ } from '../lib/format.js'
import { sharedPointer } from '../lib/routine-lookup.js'

// `onStop`: run when a sign-out stops the timers, after its settle() and before its logout.
const h = vi.hoisted(() => ({ api: null, toasts: [], onStop: null }))
vi.mock('../lib/api.js', () => ({ api: (...a) => h.api(...a), setRemoteAuth: () => {} }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: m => h.toasts.push(m), stopRest: () => h.onStop?.(), abandonWork: () => {} }) } }))

const clone = v => JSON.parse(JSON.stringify(v))
const w = (id, d = '2026-09-01') => ({ id, d, start: 1, end: 2, entries: [] })
const routine = id => ({ id, name: id, exercises: [] })
const ids = st => (st?.workouts || []).map(x => x.id).sort()
const httpError = (status, data) => Object.assign(new Error(data?.error || 'HTTP ' + status), { status, data })
const saved = () => JSON.parse(localStorage.getItem('gym_state_v1') || 'null')

let DEF
let OWNER = 'o0'

/* The browser's storage events, per tab. Each tab's 'storage' listeners are kept apart (openTab),
   and every write is told to every other tab at once, while the writer goes on: the other tab sees
   storage as it is at that write, which is when the browser's event reaches a quick tab. A tab in
   the middle of its own action (act) or handler hears of writes once it is done. */
let tabs = []
let writer = null
const realSet = Storage.prototype.setItem
const realRemove = Storage.prototype.removeItem
const pump = () => {
  for (let again = true; again;) {
    again = false
    for (const t of tabs) {
      if (t.busy || !t.inbox.length) continue
      const ev = t.inbox.shift()
      const prev = writer
      writer = t; t.busy++
      try { for (const l of t.ls) l(new StorageEvent('storage', ev)) } finally { t.busy--; writer = prev }
      again = true
    }
  }
}
const emit = (key, newValue) => {
  for (const t of tabs) if (t !== writer) t.inbox.push({ key, newValue })
  pump()
}
beforeEach(() => {
  Storage.prototype.setItem = function (k, v) { realSet.call(this, k, v); emit(k, String(v)) }
  Storage.prototype.removeItem = function (k) { realRemove.call(this, k); emit(k, null) }
})
afterEach(() => {
  Storage.prototype.setItem = realSet
  Storage.prototype.removeItem = realRemove
})
// `fn` run as tab `t`: its writes are the ones the others hear of.
async function act(t, fn) {
  const tab = tabs.find(x => x.store === t)
  tab.busy++; writer = tab
  try { return await fn() } finally { tab.busy--; writer = null; pump() }
}

async function openTab(user) {
  const tab = { store: null, ls: [], inbox: [], busy: 0 }
  const add = window.addEventListener
  window.addEventListener = function (type, l, o) { if (type === 'storage') tab.ls.push(l); else add.call(this, type, l, o) }
  try {
    const m = await freshStore()
    DEF = m.DEF
    tab.store = m.useStore
  } finally { window.addEventListener = add }
  tabs.push(tab)
  tab.store.setState({ user: user ?? null, ready: true })
  return tab.store
}

function server(doc) {
  const s = { doc: doc ? clone(doc) : null }
  h.api = async (path, opts = {}) => {
    const method = opts.method || 'GET'
    const body = opts.body ? JSON.parse(opts.body) : undefined
    if (method === 'GET' && path === '/api/data/rev') return { rev: s.doc?._rev || 0 }
    if (method === 'GET' && path === '/api/data') return { state: s.doc ? clone(s.doc) : null, rev: s.doc?._rev || 0 }
    if (method === 'PUT' && path === '/api/data') {
      const curRev = s.doc?._rev || 0
      if (body.baseRev != null && body.baseRev !== curRev) throw httpError(409, { error: 'conflict', rev: curRev, state: clone(s.doc) })
      delete body.state.active
      body.state._rev = curRev + 1
      s.doc = body.state
      return { ok: true, rev: body.state._rev }
    }
    if (method === 'POST' && path.startsWith('/api/logout')) return { ok: true }
    throw new Error('unexpected ' + method + ' ' + path)
  }
  return s
}
const account = () => ({
  ...clone(DEF), _ts: 100, restSec: 120, accent: 'sky',
  workouts: [w('x1'), w('x2', '2026-09-02'), w('x3', '2026-09-03')],
  routines: [routine('xr')], bodyweight: [{ d: '2026-09-01', w: 80, t: 1 }],
})
const savedCopy = (doc, rev) => {
  const S = clone(doc); delete S._rev
  localStorage.setItem('gym_state_v1', JSON.stringify(S))
  // The marker as the owner's tab left it, naming that account (NATG-556).
  localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts, uid: localStorage.getItem('gym_owner') }))
}
// Every PUT /api/data the server receives from here on, from either tab, with the revision it was
// sent against.
const recordPuts = puts => {
  const answer = h.api
  h.api = (path, opts = {}) => {
    if (opts.method === 'PUT' && path === '/api/data') {
      const body = JSON.parse(opts.body)
      puts.push({ baseRev: body.baseRev ?? null, state: body.state })
    }
    return answer(path, opts)
  }
}
// `hold(method, path)`: the next such request, to whichever server h.api is now, is answered as it
// arrives (refused, 409 and all, as the server would), and that answer held until `release()`, as
// QA's route held the real one. `asked` resolves once it has arrived. `release()` fails the test
// unless that very request is out and its answer not yet back: a hold that stopped holding would
// let the tests pass without the race they are about (NATG-594). One whose request never comes
// leaves its test waiting on `asked` until it times out; the test's afterEach then names it.
let unasked = []
const hold = (method, path = '/api/data') => {
  const answer = h.api
  const g = {}
  const name = `hold('${method}', '${path}')`
  let arrived = null, answered = false
  g.asked = new Promise(r => { g.ask = r })
  let letGo
  const released = new Promise(r => { letGo = r })
  g.release = () => {
    expect(arrived, `${name}: released before its request arrived`).not.toBeNull()
    expect(arrived, `${name}: held the wrong request`).toBe(method + ' ' + path)
    expect(answered, `${name}: its answer was back before release()`).toBe(false)
    letGo()
  }
  unasked.push(() => arrived ? null : name)
  h.api = async (p, opts = {}) => {
    if ((opts.method || 'GET') === method && p === path) {
      h.api = answer
      arrived = (opts.method || 'GET') + ' ' + p
      let res, err = null
      try { res = await answer(p, opts) } catch (e) { err = e }
      g.ask()
      await released
      answered = true
      if (err) throw err
      return res
    }
    return answer(p, opts)
  }
  return g
}

beforeEach(async () => {
  localStorage.clear()
  OWNER = 'o' + (Number(OWNER.slice(1)) + 1)
  DEF = (await import('./useStore.js')).DEF
})
afterEach(() => {
  tabs = []
  localStorage.clear()
  const missed = unasked.map(f => f()).filter(Boolean)
  unasked = []
  expect(missed, 'held requests that never arrived').toEqual([])
})

describe('a second tab while the first one changes owner', () => {
  it('sign-out with a second tab open leaves nothing of the account in the browser', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    expect(ids(B.getState().S)).toEqual(['x1', 'x2', 'x3'])

    const r = await act(A, () => A.getState().signOut())
    expect(r.owed).toBe(false)

    expect(ids(saved())).toEqual([])
    expect(saved().routines).toEqual([])
    expect(saved().bodyweight).toEqual([])
    expect(ids(B.getState().S)).toEqual([])
    expect(B.getState().user).toBeNull()
    // The next guest here, in either tab or a new one, starts empty.
    const G = await openTab(null)
    expect(ids(G.getState().S)).toEqual([])
    await act(B, () => B.getState().update(s => { s.restSec = 45 }))
    expect(ids(saved())).toEqual([])
    expect(saved().routines).toEqual([])
  })

  it('a device-link sign-in to another account with a second tab open copies nothing of the old account', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    const yan = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }
    srv.doc = yan   // the server now answers as Yan's account

    await act(A, () => A.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
    // The question counts nothing of Xavi's as this device's own work.
    const pre = JSON.parse(localStorage.getItem('gym_adopt')).pre
    expect(pre.workouts || []).toEqual([])
    expect(pre.routines || []).toEqual([])
    expect(ids(saved())).toEqual([])
    expect(ids(B.getState().S)).toEqual([])

    await act(A, () => A.getState().adoptProfile(async () => false))   // "Keep profile as is"
    expect(ids(srv.doc)).toEqual(['yW1'])
    expect(srv.doc.routines || []).toEqual([])
    expect(ids(saved())).toEqual(['yW1'])
    await act(B, () => B.getState().update(s => { s.bodyweight = [...(s.bodyweight || []), { d: '2026-09-06', w: 70, t: Date.now() }] }))
    await act(A, () => A.getState().pushState())
    expect(ids(srv.doc)).toEqual(['yW1'])
    expect(srv.doc.routines || []).toEqual([])
    expect((srv.doc.bodyweight || []).some(e => e.w === 80)).toBe(false)
  })

  // NATG-600: the same switch kept the new account's workouts but put a fresh profile's settings
  // in both tabs and in storage, and the first tab's next boot pushed them over the account's.
  it('a direct sign-in to another account with "Keep profile as is" keeps that account\'s settings in both tabs, and after the other tab boots', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    const bea = { id: 'B-' + OWNER, name: 'Bea' }
    srv.doc = { ...clone(DEF), _ts: 10, gifSize: 'full', weighIn: true, workouts: [w('bW1', '2026-09-05')], _rev: 7 }
    // The server now answers as Bea's account, boot's requests included.
    const answer = h.api
    h.api = async (path, opts = {}) => {
      if (path === '/api/config') return {}
      if (path === '/api/me') return { user: bea }
      if (path === '/api/shares') return { incoming: [], outgoing: [], etag: 'shares-' + bea.id }
      return answer(path, opts)
    }
    const prefs = s => ({ gifSize: s?.gifSize, weighIn: s?.weighIn })
    const beas = { gifSize: 'full', weighIn: true }

    await act(B, () => B.getState().setUser(bea, { adopt: true }))
    await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
    await act(A, () => new Promise(r => setTimeout(r, 20)))
    expect(prefs(A.getState().S)).toEqual(beas)
    expect(prefs(B.getState().S)).toEqual(beas)
    expect(prefs(saved())).toEqual(beas)
    expect(ids(A.getState().S)).toEqual(['bW1'])
    expect(ids(B.getState().S)).toEqual(['bW1'])

    A.setState({ ready: false })
    await act(A, () => A.getState().boot())
    expect(A.getState().user?.id).toBe(bea.id)
    expect(prefs(srv.doc)).toEqual(beas)
    expect(ids(srv.doc)).toEqual(['bW1'])
    expect(prefs(A.getState().S)).toEqual(beas)
    expect(prefs(B.getState().S)).toEqual(beas)
    expect(prefs(saved())).toEqual(beas)
  })

  it('a guest tab left open after "Keep profile as is" puts none of the guest copy into the account', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 3 })
    localStorage.setItem('gym_state_v1', JSON.stringify({
      ...clone(DEF), _ts: Date.now(), restSec: 90, accent: 'lime',
      workouts: [w('gW1', '2026-09-04')], routines: [routine('Guest Routine')],
    }))
    const A = await openTab(null)
    const B = await openTab(null)

    await act(A, () => A.getState().setUser({ id: OWNER, name: 'Xavi' }, { adopt: true }))
    // B, a guest until now, holds nothing while the question is open and writes nothing.
    expect(ids(B.getState().S)).toEqual([])
    await act(B, () => B.getState().update(s => { s.bodyweight = [{ d: '2026-09-06', w: 60, t: Date.now() }] }))
    expect(ids(saved())).toEqual(['gW1'])   // still the guest copy the question is about

    await act(A, () => A.getState().adoptProfile(async () => false))   // "Keep profile as is"
    expect(ids(srv.doc)).toEqual(['x1', 'x2', 'x3'])
    // B now holds the account's copy as it is, and its next change joins the account normally.
    expect(ids(B.getState().S)).toEqual(['x1', 'x2', 'x3'])
    expect(B.getState().S.restSec).toBe(120)
    await act(B, () => B.getState().update(s => { s.bodyweight = [...(s.bodyweight || []), { d: '2026-09-07', w: 81, t: Date.now() }] }))
    A.setState({ ready: true })
    await act(A, () => A.getState().pushState())
    expect(ids(srv.doc)).toEqual(['x1', 'x2', 'x3'])
    expect((srv.doc.routines || []).map(r => r.id)).toEqual(['xr'])
    expect(srv.doc.restSec).toBe(120)
    expect(srv.doc.accent).toBe('sky')
    expect(srv.doc.bodyweight.map(e => e.w).sort()).toEqual([80, 81])
    // The weigh-in B logged in the moment it held no copy is kept aside, not lost.
    const stash = JSON.parse(localStorage.getItem('gym_stash') || '{}')
    expect(Object.values(stash).some(e => (e.state.bodyweight || []).some(b => b.w === 60))).toBe(true)
  })
})

// RC review 2026-10-07: a guest tab left open while the other tab created a profile went blank
// until that tab saved something, and one mid-workout jumped to the sign-in screen with its
// workout gone from view (it had gone into the account) and nothing said.
describe('a guest tab while the other tab signs in or creates a profile', () => {
  const running = () => ({ id: 'act1', start: Date.now() - 600000, entries: [{ id: 'bench', sets: [{ w: 60, r: 5, done: true }] }] })
  const guestCopy = active => ({ ...clone(DEF), _ts: Date.now(), workouts: [w('gW1', '2026-09-04')], active })
  // The tab shows the workout (HashRouter). RC verify 2026-10-07: the toast also came up in a tab
  // on another screen that never showed it, and told the workout tab to go elsewhere.
  beforeEach(() => { location.hash = '#/workout' })
  afterEach(() => { location.hash = '' })

  it('a profile created in the other tab shows in the guest tab at once, and the workout with it', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server(null)
    localStorage.setItem('gym_state_v1', JSON.stringify(guestCopy(running())))
    localStorage.setItem('gym_guest', '1')
    const A = await openTab(null)
    const B = await openTab(null)
    expect(B.getState().S.active?.id).toBe('act1')
    h.toasts = []
    // Register (views/Login.jsx): setUser without a question, then the push of this copy.
    await act(A, () => A.getState().setUser({ id: OWNER, name: 'Nova' }))
    expect(ids(B.getState().S)).toEqual(['gW1'])          // not blank
    expect(B.getState().S.active?.id).toBe('act1')
    await new Promise(r => setTimeout(r, 0))   // the toast comes through a lazy import
    expect(h.toasts).toContain('Signed in from another tab. Your workout came along, keep going here.')
    await act(A, () => A.getState().pushState())
    expect(ids(srv.doc)).toEqual(['gW1'])
    // B follows the sign-in once the copy is the account's and in step with the server.
    expect(B.getState().user?.id).toBe(OWNER)
    expect(B.getState().S.active?.id).toBe('act1')
  })

  it('a sign-in to an existing account: the guest tab gets the account, the running workout included, once it is answered', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 3 })
    localStorage.setItem('gym_state_v1', JSON.stringify(guestCopy(running())))
    localStorage.setItem('gym_guest', '1')
    const A = await openTab(null)
    const B = await openTab(null)
    h.toasts = []
    await act(A, () => A.getState().setUser({ id: OWNER, name: 'Xavi' }, { adopt: true }))
    await new Promise(r => setTimeout(r, 0))   // the toast comes through a lazy import
    expect(h.toasts).toContain('Signed in from another tab. Your workout came along, keep going here.')
    expect(B.getState().user).toBe(null)                      // nothing taken while the question is open
    await act(A, () => A.getState().adoptProfile(async () => false))   // "Keep profile as is"
    expect(ids(srv.doc)).toEqual(['x1', 'x2', 'x3'])
    expect(A.getState().S.active?.id).toBe('act1')
    expect(ids(B.getState().S)).toEqual(['x1', 'x2', 'x3'])
    expect(B.getState().S.active?.id).toBe('act1')
    expect(B.getState().user?.id).toBe(OWNER)
  })

  it('a guest tab on another screen is not told about a workout it does not show', async () => {
    DEF = (await import('./useStore.js')).DEF
    server(null)
    localStorage.setItem('gym_state_v1', JSON.stringify(guestCopy(running())))
    localStorage.setItem('gym_guest', '1')
    location.hash = '#/stats'
    const A = await openTab(null)
    const B = await openTab(null)
    h.toasts = []
    await act(A, () => A.getState().setUser({ id: OWNER, name: 'Nova' }))
    await new Promise(r => setTimeout(r, 0))
    expect(h.toasts.some(m => /another tab/.test(m))).toBe(false)
    expect(B.getState().S.active?.id).toBe('act1')
  })

  it('a new profile with nothing in it: the other tab takes it without waiting for a save', async () => {
    DEF = (await import('./useStore.js')).DEF
    server(null)
    localStorage.setItem('gym_state_v1', JSON.stringify({ ...clone(DEF), _ts: Date.now(), restSec: 75 }))
    const A = await openTab(null)
    const B = await openTab(null)
    await act(A, () => A.getState().setUser({ id: OWNER, name: 'Empty' }, { adopt: true }))
    await act(A, () => A.getState().adoptProfile(async () => true))
    expect(B.getState().S.restSec).toBe(75)
    expect(localStorage.getItem('gym_state_owner')).toBe(OWNER)
  })
})


// NATG-496 (QA 2026-11-03): a pull this tab started for the account, answered by the server as
// that account, but landing only after another tab signed out (or into another account). The
// answer was taken as the signed-out tab's copy and saved, so the account's routines came back in
// a tab that showed nobody signed in, and the next sign-in was asked to adopt them.
describe('a pull still on its way when another tab changes the owner', () => {
  // hold('GET'): the pull's GET /api/data is answered as the account it was sent for, then held.
  it('an answer landing after a sign-out in the other tab is dropped, in both tabs and in storage', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })

    const held = hold('GET')
    const pull = A.getState().pullState()
    await held.asked
    await act(B, () => B.getState().signOut())
    expect(A.getState().user).toBeNull()
    expect(A.getState().S.routines).toEqual([])

    held.release()
    await act(A, () => pull)
    expect(A.getState().user).toBeNull()
    expect(A.getState().S.routines).toEqual([])
    expect(ids(A.getState().S)).toEqual([])
    expect(B.getState().S.routines).toEqual([])
    expect(ids(B.getState().S)).toEqual([])
    expect(saved().routines).toEqual([])
    expect(ids(saved())).toEqual([])

    // The next account signing in here is not asked about the signed-out account's workouts.
    server({ ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 2 })
    await act(B, () => B.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
    const pre = JSON.parse(localStorage.getItem('gym_adopt') || 'null')?.pre
    expect(pre?.workouts || []).toEqual([])
    expect(pre?.routines || []).toEqual([])
  })

  // NATG-528: the answer lands while this tab's storage events for the sign-out are still queued,
  // so its store still names the account. Taken, it was saved under the owner the sign-out had
  // just cleared, which moved this tab's own idea of the owner along: the queued owner event then
  // found nothing to clear, a fresh tab loaded the account's copy, and the next sign-in was asked
  // to adopt its workouts.
  it('an answer landing before this tab has heard of the sign-out is dropped too, and stays dropped', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    // Another device's newer revision, so the held answer is one this tab would take and save.
    srv.doc = { ...srv.doc, routines: [routine('xr'), routine('xr-newer')], _ts: 200, _rev: 2 }

    const held = hold('GET')
    const pull = A.getState().pullState()
    await held.asked
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++   // tab 1's storage callbacks wait, in order, until the answer has landed
    try {
      await act(B, () => B.getState().signOut())
      expect(localStorage.getItem('gym_owner')).toBeNull()
      expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
      writer = tabA
      held.release()
      await pull
    } finally { writer = null; tabA.busy-- }
    pump()   // the queued callbacks, as the browser delivers them once tab 1 is free

    expect(A.getState().user).toBeNull()
    expect(A.getState().S.routines).toEqual([])
    expect(ids(A.getState().S)).toEqual([])
    expect(ids(B.getState().S)).toEqual([])
    expect(saved().routines).toEqual([])
    expect(ids(saved())).toEqual([])
    const G = await openTab(null)   // a fresh signed-out tab
    expect(G.getState().S.routines).toEqual([])
    expect(ids(G.getState().S)).toEqual([])
    server({ ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 3 })
    await act(G, () => G.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
    const pre = JSON.parse(localStorage.getItem('gym_adopt') || 'null')?.pre
    expect(pre?.workouts || []).toEqual([])
    expect(pre?.routines || []).toEqual([])
  })

  // The pull sends a change still waiting in the debounce first. That push's 409 carries the
  // account's document; merged in after the owner left, it went into the browser the same way.
  it('a conflict answer to the pull\'s own push, landing before this tab has heard of the sign-out, merges nothing in', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    srv.doc = { ...srv.doc, routines: [routine('xr'), routine('xr-newer')], _ts: 200, _rev: 2 }
    await act(A, () => A.getState().update(s => { s.restSec = 90 }))   // waits in the debounce

    // The PUT held once the server has refused it with its document (409), as the pull's GET above.
    const held = hold('PUT')
    const pull = A.getState().pullState()
    await held.asked
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++
    try {
      await act(B, () => B.getState().signOut())
      expect(A.getState().user?.id).toBe(OWNER)
      writer = tabA
      held.release()
      await pull
    } finally { writer = null; tabA.busy-- }
    pump()

    expect(A.getState().user).toBeNull()
    expect(A.getState().S.routines).toEqual([])
    expect(ids(A.getState().S)).toEqual([])
    expect(saved().routines).toEqual([])
    expect(ids(saved())).toEqual([])
    expect(localStorage.getItem('gym_sync')).toBeNull()   // no marker of the account's revision either
  })

  it('an answer landing after the other tab signed in to another account is dropped', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })

    const held = hold('GET')
    const pull = A.getState().pullState()
    await held.asked
    srv.doc = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }   // the server now answers as Yan
    await act(B, () => B.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
    expect(A.getState().user).toBeNull()

    held.release()
    await act(A, () => pull)
    expect(A.getState().S.routines).toEqual([])
    expect(ids(A.getState().S)).toEqual([])
    expect(ids(saved())).toEqual([])
    expect(saved().routines || []).toEqual([])
    const pre = JSON.parse(localStorage.getItem('gym_adopt')).pre
    expect(pre.workouts || []).toEqual([])
    expect(pre.routines || []).toEqual([])
  })

  it('the account signed in after the switch gets a pull of its own, not the old one', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })

    const held = hold('GET')
    const old = A.getState().pullState()
    await held.asked
    await act(A, () => A.getState().setUser(null))
    srv.doc = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }
    await act(A, () => A.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }))
    let gets = 0
    const answer = h.api
    h.api = (path, opts = {}) => { if ((opts.method || 'GET') === 'GET' && path === '/api/data') gets++; return answer(path, opts) }
    await act(A, () => A.getState().pullState())
    expect(gets).toBe(1)
    expect(ids(A.getState().S)).toEqual(['yW1'])

    held.release()
    await act(A, () => old)
    expect(A.getState().user?.id).toBe('Y-' + OWNER)
    expect(ids(A.getState().S)).toEqual(['yW1'])
    expect(ids(saved())).toEqual(['yW1'])
  })

  it('an answer for the account still signed in is taken as before', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    await openTab({ id: OWNER, name: 'Xavi' })
    srv.doc = { ...srv.doc, routines: [routine('xr'), routine('xr2')], _ts: 200, _rev: 2 }   // another device's edit

    const held = hold('GET')
    const pull = A.getState().pullState()
    await held.asked
    held.release()
    await act(A, () => pull)
    expect(A.getState().user?.id).toBe(OWNER)
    expect(A.getState().S.routines.map(r => r.id)).toEqual(['xr', 'xr2'])
    expect(saved().routines.map(r => r.id)).toEqual(['xr', 'xr2'])
  })
})

// Security review of PR #15 (SEC-01, SEC-02): requests the sync code sends after an await, for an
// account that has left by then. A server with two accounts, and the session cookie the browser
// holds: a request is answered as whoever that cookie names when it arrives, as the real API does.
describe('a request sent after its account has left the browser', () => {
  function accounts(docs) {
    const s = { docs: clone(docs), session: null, logoutFails: false, sent: [] }
    const answer = (method, path, body, who) => {
      if (method === 'POST' && path.startsWith('/api/logout')) {
        if (s.logoutFails) throw Object.assign(new TypeError('Failed to fetch'), { status: 0 })
        s.session = null
        return { ok: true }
      }
      if (method === 'GET' && path === '/api/config') return {}
      if (!who) throw httpError(401, { error: 'not signed in' })
      if (method === 'GET' && path === '/api/me') return { user: { id: who, name: who } }
      if (method === 'GET' && path === '/api/shares') return { incoming: [], outgoing: [], etag: 'shares-' + who }
      const doc = s.docs[who] || null
      if (method === 'GET' && path === '/api/data/rev') return { rev: doc?._rev || 0 }
      if (method === 'GET' && path === '/api/data') return { state: doc ? clone(doc) : null, rev: doc?._rev || 0 }
      if (method === 'PUT' && path === '/api/data') {
        const curRev = doc?._rev || 0
        if (body.baseRev != null && (body.baseRev !== curRev || (body.baseWid && doc?._wid && body.baseWid !== doc._wid))) throw httpError(409, { error: 'conflict', rev: curRev, state: clone(doc) })
        const next = clone(body.state)
        delete next.active
        next._rev = curRev + 1
        // A write id per document write, and the ones it descends from, as api/server.js keeps them.
        next._wid = who + '-w' + next._rev
        next._wids = [...(doc?._wids || []), ...(doc?._wid ? [doc._wid] : [])].slice(-20)
        s.docs[who] = next
        return { ok: true, rev: next._rev, wid: next._wid }
      }
      throw new Error('unexpected ' + method + ' ' + path)
    }
    // A request `hold` keeps back is still sent, and answered, under the session it arrived with.
    h.api = async (path, opts = {}) => {
      const method = opts.method || 'GET'
      const body = opts.body ? JSON.parse(opts.body) : undefined
      const who = s.session
      s.sent.push({ method, path, who })
      return answer(method, path, body, who)
    }
    return s
  }
  const settleTicks = () => new Promise(r => setTimeout(r, 20))

  // SEC-01: the first upload of a profile (no revision yet, as one created from a guest's copy),
  // with a change pushed while it was on its way. The upload's answer lands after the other tab
  // signed out and signed in as B, before this tab has heard of either: dropped, but the push
  // queued behind it went anyway, without a revision, under B's session, and replaced B's profile
  // with A's copy.
  it('SEC-01: a push queued behind a dropped answer is not sent under the next account\'s session', async () => {
    DEF = (await import('./useStore.js')).DEF
    const aId = OWNER, bId = 'B-' + OWNER
    const bDoc = { ...clone(DEF), _ts: 10, workouts: [w('bW1', '2026-09-05')], routines: [routine('br')], _rev: 5 }
    const srv = accounts({ [bId]: bDoc })
    srv.session = aId
    localStorage.setItem('gym_owner', aId)
    localStorage.setItem('gym_state_v1', JSON.stringify({ ...account(), _ts: 100 }))   // no gym_sync: never uploaded
    const A = await openTab({ id: aId, name: 'Xavi' })
    const B = await openTab({ id: aId, name: 'Xavi' })

    const held = hold('PUT')
    const first = A.getState().pushState()
    await held.asked
    A.getState().pushState()   // asked for while the upload is out, before anything changes owner
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++   // tab 1's storage callbacks wait, in order, until the answer has landed
    try {
      await act(B, () => B.getState().signOut())
      srv.session = bId   // B signs in through the server in tab 2: the browser's cookie is B's
      await act(B, () => B.getState().setUser({ id: bId, name: 'Bea' }, { adopt: true }))
      expect(A.getState().user?.id).toBe(aId)   // not heard of yet
      writer = tabA
      held.release()
      await first
      await settleTicks()   // whatever the answer's landing started
    } finally { writer = null; tabA.busy-- }
    pump()

    expect(srv.sent.filter(r => r.method === 'PUT' && r.who === bId)).toEqual([])
    expect(ids(srv.docs[bId])).toEqual(['bW1'])
    expect(srv.docs[bId].routines.map(r => r.id)).toEqual(['br'])
    expect(srv.docs[bId]._rev).toBe(5)
    expect(A.getState().user).toBeNull()
  })

  // Found by the sweep: the sign-in question can stay open for minutes. Answered after the other
  // tab signed in as B (this tab not having heard yet), it asked the server again under B's
  // session, then answered the question for the browser, wiping B's own sign-in question.
  it('a sign-in question answered after the other tab signed in as someone else settles nothing', async () => {
    DEF = (await import('./useStore.js')).DEF
    const aId = OWNER, bId = 'B-' + OWNER
    const srv = accounts({
      [aId]: { ...account(), _rev: 3 },
      [bId]: { ...clone(DEF), _ts: 10, workouts: [w('bW1', '2026-09-05')], _rev: 5 },
    })
    localStorage.setItem('gym_state_v1', JSON.stringify({ ...clone(DEF), _ts: Date.now(), workouts: [w('gW1', '2026-09-04')] }))   // a guest's copy
    const A = await openTab(null)
    const B = await openTab(null)
    srv.session = aId
    await act(A, () => A.getState().setUser({ id: aId, name: 'Xavi' }, { adopt: true }))
    let answer, opened
    const isOpen = new Promise(r => { opened = r })
    const adopting = A.getState().adoptProfile(() => { opened(); return new Promise(r => { answer = r }) })
    await isOpen

    const tabA = tabs.find(x => x.store === A)
    tabA.busy++
    try {
      srv.session = bId
      await act(B, () => B.getState().setUser({ id: bId, name: 'Bea' }, { adopt: true }))
      expect(A.getState().user?.id).toBe(aId)   // not heard of yet
      writer = tabA
      answer(false)   // "Keep profile as is"
      await adopting
      await settleTicks()
    } finally { writer = null; tabA.busy-- }
    pump()

    expect(srv.sent.filter(r => r.who === bId)).toEqual([])   // nothing asked or sent under B's session
    expect(JSON.parse(localStorage.getItem('gym_adopt'))?.uid).toBe(bId)   // B's own question still stands
    expect(ids(saved())).not.toContain('x1')
    expect(ids(srv.docs[bId])).toEqual(['bW1'])
  })

  // SEC-03: tab 1 reloads while signed in as A, with A's copy in step with A's revision, and its
  // first wait (/api/config) outlasts the other tab signing out, signing in as B and settling B's
  // sign-in. Boot then took the owner it saw after that wait (B) as its own, /api/me answered B,
  // setUser(B) took A's copy and revision for B's, and the pull merged A's entries into B's
  // document (their write ids do not descend from each other) and pushed them with B's own
  // revision, which the server accepted.
  it('SEC-03: a boot whose first answer lands after the other tab signed in as B syncs nothing into B', async () => {
    DEF = (await import('./useStore.js')).DEF
    const aId = OWNER, bId = 'B-' + OWNER
    const aDoc = { ...account(), _rev: 3, _wid: aId + '-w3', _wids: [aId + '-w2'] }
    const bDoc = { ...clone(DEF), _ts: 10, workouts: [w('bW1', '2026-09-05')], routines: [routine('br')], _rev: 7, _wid: bId + '-w7', _wids: [bId + '-w6'] }
    const srv = accounts({ [aId]: aDoc, [bId]: bDoc })
    srv.session = aId
    localStorage.setItem('gym_owner', aId)
    localStorage.setItem('gym_user', JSON.stringify({ id: aId, name: 'Xavi' }))
    const S = clone(aDoc); delete S._rev
    localStorage.setItem('gym_state_v1', JSON.stringify(S))
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 3, ts: S._ts, wid: aId + '-w3', uid: aId }))
    const A = await openTab({ id: aId, name: 'Xavi' })   // the tab that reloads
    const B = await openTab({ id: aId, name: 'Xavi' })
    A.setState({ ready: false })
    const bBefore = clone(srv.docs[bId])

    const held = hold('GET', '/api/config')
    const booting = A.getState().boot()
    await held.asked
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++   // tab 1's storage callbacks wait, in order, until its boot has gone on
    try {
      await act(B, () => B.getState().signOut())
      srv.session = bId
      await act(B, () => B.getState().setUser({ id: bId, name: 'Bea' }, { adopt: true }))
      await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
      expect(ids(saved())).toEqual(['bW1'])
      writer = tabA
      held.release()
      await booting
      await settleTicks()
    } finally { writer = null; tabA.busy-- }
    pump()
    await act(A, settleTicks)

    expect(srv.sent.filter(r => r.method === 'PUT' && r.who === bId)).toEqual([])
    expect(srv.docs[bId]).toEqual(bBefore)
    expect(ids(saved())).toEqual(['bW1'])
    // Tab 1 ends on B's own copy, through the follow path, not on A's relabelled as B's.
    expect(ids(A.getState().S)).not.toContain('x1')
  })

  // SEC-04: boot's own writes, made after the owner moved with this tab's storage callbacks still
  // queued. Its pull rightly dropped its answer, but boot went on to write A's copy anyway: the
  // reminder's timezone refresh after the pull, and the pointer sweep a share-list load left owed
  // until boot was through. Either went through update() and persist(), which, not having heard of
  // the handover yet, saved A's whole copy under the new owner and moved seenOwner, so the owner
  // event found nothing to hand over. The next guest tab opened A's history; a tab signed in as B
  // started from A's copy. Each case is run against a sign-out in the other tab, and against a
  // sign-out followed by B's sign-in ("Keep profile as is").
  const otherTz = localTZ() === 'Pacific/Chatham' ? 'Pacific/Kiritimati' : 'Pacific/Chatham'
  async function bootThroughOwnerChange({ aDoc, hold: heldPath, during = async () => {}, toB }) {
    const aId = OWNER, bId = 'B-' + OWNER
    const bDoc = { ...clone(DEF), _ts: 10, workouts: [w('bW1', '2026-09-05')], routines: [routine('br')], _rev: 7, _wid: bId + '-w7', _wids: [bId + '-w6'] }
    const srv = accounts({ [aId]: aDoc, [bId]: bDoc })
    srv.session = aId
    localStorage.setItem('gym_owner', aId)
    localStorage.setItem('gym_user', JSON.stringify({ id: aId, name: 'Xavi' }))
    const S = clone(aDoc); delete S._rev
    localStorage.setItem('gym_state_v1', JSON.stringify(S))
    localStorage.setItem('gym_sync', JSON.stringify({ rev: aDoc._rev, ts: S._ts, wid: aDoc._wid, uid: aId }))
    const A = await openTab({ id: aId, name: 'Xavi' })   // the tab that reloads
    const B = await openTab({ id: aId, name: 'Xavi' })
    A.setState({ ready: false })
    const bBefore = clone(srv.docs[bId])

    const held = hold('GET', heldPath)
    const booting = A.getState().boot()
    await held.asked
    await during(A)
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++   // tab 1's storage callbacks wait, in order, until its boot has gone on
    try {
      await act(B, () => B.getState().signOut())
      if (toB) {
        srv.session = bId
        await act(B, () => B.getState().setUser({ id: bId, name: 'Bea' }, { adopt: true }))
        await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
      }
      writer = tabA
      held.release()
      await booting
      await settleTicks()
    } finally { writer = null; tabA.busy-- }
    pump()
    await act(A, settleTicks)
    return { srv, bId, bBefore }
  }
  // What the browser holds afterwards, as a tab opened now sees it, and what reached B's server
  // document. (Tab 2's sign-out settles A's own copy with A's server first, as it always does.)
  async function expectNothingOfA({ srv, bId, bBefore }, toB) {
    if (!toB) {
      expect(ids(saved())).toEqual([])
      expect(saved().routines).toEqual([])
      const G = await openTab(null)   // a fresh guest tab
      expect(ids(G.getState().S)).toEqual([])
      expect(G.getState().S.routines).toEqual([])
      return
    }
    expect(ids(saved())).toEqual(['bW1'])
    expect(saved().routines.map(r => r.id)).toEqual(['br'])
    // A fresh tab signed in as B boots and syncs from what the browser holds: B's own copy.
    const F = await openTab({ id: bId, name: 'Bea' })
    F.setState({ ready: false })
    await act(F, () => F.getState().boot())
    await act(F, settleTicks)
    expect(ids(F.getState().S)).toEqual(['bW1'])
    expect(srv.sent.filter(r => r.method === 'PUT' && r.who === bId)).toEqual([])
    expect(srv.docs[bId]).toEqual(bBefore)
  }

  for (const [label, toB] of [['signs out', false], ['signs out and in as B', true]]) {
    it(`SEC-04: boot's timezone refresh writes nothing of A once the other tab ${label}`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const aId = OWNER
      const aDoc = {
        ...account(), reminder: { ...clone(DEF).reminder, on: true, tz: otherTz },
        _rev: 3, _wid: aId + '-w3', _wids: [aId + '-w2'],
      }
      const run = await bootThroughOwnerChange({ aDoc, hold: '/api/data', toB })   // /api/me has answered A
      await expectNothingOfA(run, toB)
    })

    it(`SEC-04: boot's owed pointer sweep writes nothing of A once the other tab ${label}`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const aId = OWNER
      // A's plan still names a share that has since been revoked: the lists' answer finds it gone.
      const aDoc = { ...account(), week: { 1: sharedPointer('gone') }, _rev: 3, _wid: aId + '-w3', _wids: [aId + '-w2'] }
      const run = await bootThroughOwnerChange({
        aDoc, hold: '/api/me', toB,
        // The lists load while boot is out asking who this is: their sweep waits for finishBoot.
        during: async A => { expect(await A.getState().loadShares()).toBeTruthy() },
      })
      await expectNothingOfA(run, toB)
    })
  }

  // SEC-02: a revision check whose answer is held while this tab signs out, with the logout not
  // reaching the server (the cookie survives, the logout is owed). Released, the check pulled with
  // nobody signed in, the surviving cookie answered as A, and A's copy was taken as the signed-out
  // browser's own: an answer for nobody matched nobody signed in.
  it('SEC-02: a revision answer landing after a sign-out whose logout failed pulls nothing in', async () => {
    DEF = (await import('./useStore.js')).DEF
    const aId = OWNER
    const srv = accounts({ [aId]: { ...account(), _rev: 1 } })
    srv.session = aId
    localStorage.setItem('gym_owner', aId)
    savedCopy(srv.docs[aId], 1)
    const A = await openTab({ id: aId, name: 'Xavi' })
    srv.docs[aId] = { ...srv.docs[aId], routines: [routine('xr'), routine('xr-newer')], _ts: 200, _rev: 2 }   // another device

    const held = hold('GET', '/api/data/rev')
    window.dispatchEvent(new Event('online'))   // the revision check, unthrottled
    await held.asked
    srv.logoutFails = true
    await act(A, () => A.getState().signOut())
    expect(A.getState().user).toBeNull()
    expect(localStorage.getItem('gym_logout_owed')).toBe('1')
    const sentBefore = srv.sent.length

    held.release()
    await act(A, settleTicks)

    expect(srv.sent.slice(sentBefore)).toEqual([])   // nothing asked for nobody
    expect(A.getState().user).toBeNull()
    expect(A.getState().S.routines).toEqual([])
    expect(ids(A.getState().S)).toEqual([])
    expect(saved().routines).toEqual([])
    expect(ids(saved())).toEqual([])
  })

  // NATG-574: tab 1 reloads signed in as A, whose cookie has expired, and its /api/me is out when
  // the other tab signs out and in as B. The 401 arrives after that: it is about A's old session,
  // and boot's setUser(null) removed B's gym_user, so the other tab showed the sign-in screen
  // until its next boot. The same 401 with the owner unchanged still signs this tab out.
  // NATG-606: the other tab signs back in as A instead, after a sign-out (`roundTrip`) or after its
  // own copy of A's session expired (`reSignIn`, the owner key left at A). The owner key ends where
  // it was, so only the sign-in token shows boot that the 401 is about A's old session.
  async function bootRefused({ toB, roundTrip, reSignIn }) {
    DEF = (await import('./useStore.js')).DEF
    const aId = OWNER, bId = 'B-' + OWNER
    const aDoc = { ...account(), _rev: 3, _wid: aId + '-w3', _wids: [aId + '-w2'] }
    const bDoc = { ...clone(DEF), _ts: 10, workouts: [w('bW1', '2026-09-05')], _rev: 7, _wid: bId + '-w7', _wids: [bId + '-w6'] }
    const srv = accounts({ [aId]: aDoc, [bId]: bDoc })
    srv.session = null   // A's cookie has expired: /api/me answers 401
    localStorage.setItem('gym_owner', aId)
    localStorage.setItem('gym_user', JSON.stringify({ id: aId, name: 'Xavi' }))
    const S = clone(aDoc); delete S._rev
    localStorage.setItem('gym_state_v1', JSON.stringify(S))
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 3, ts: S._ts, wid: aId + '-w3', uid: aId }))
    const A = await openTab({ id: aId, name: 'Xavi' })   // the tab that reloads
    const B = await openTab({ id: aId, name: 'Xavi' })
    A.setState({ ready: false })

    const held = hold('GET', '/api/me')
    const booting = A.getState().boot()
    await held.asked
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++   // tab 1's storage callbacks wait, in order, until its boot has gone on
    try {
      if (toB) {
        await act(B, () => B.getState().signOut())
        srv.session = bId
        await act(B, () => B.getState().setUser({ id: bId, name: 'Bea' }, { adopt: true }))
        await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
        expect(JSON.parse(localStorage.getItem('gym_user'))?.id).toBe(bId)
      }
      if (roundTrip || reSignIn) {
        if (roundTrip) await act(B, () => B.getState().signOut())
        else await act(B, () => B.getState().setUser(null))   // tab 2's own 401: A's session is gone there too
        srv.session = aId
        await act(B, () => B.getState().setUser({ id: aId, name: 'Xavi' }, { adopt: true }))
        await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
        expect(localStorage.getItem('gym_owner')).toBe(aId)
      }
      writer = tabA
      held.release()
      await booting
      await settleTicks()
    } finally { writer = null; tabA.busy-- }
    pump()
    await act(A, settleTicks)
    return { A, B, aId, bId }
  }

  it('NATG-574: a boot 401 landing after the other tab signed in as B leaves B\'s gym_user in place', async () => {
    const { A, B, bId } = await bootRefused({ toB: true })

    expect(JSON.parse(localStorage.getItem('gym_user'))?.id).toBe(bId)
    expect(localStorage.getItem('gym_owner')).toBe(bId)
    expect(B.getState().user?.id).toBe(bId)
    // Tab 1 follows the other tab rather than saying A's session ended, onto B's own copy.
    expect(A.getState().user?.id ?? null).not.toBe(OWNER)
    expect(A.getState().sync.lastError?.code).not.toBe('auth')
    expect(ids(A.getState().S)).toEqual(['bW1'])
  })

  for (const [label, how] of [['signed out and back in as A', { roundTrip: true }], ['signed in again as A after its own session expired', { reSignIn: true }]]) {
    it(`NATG-606: a boot 401 landing after the other tab ${label} leaves A's new session signed in`, async () => {
      const { A, B, aId } = await bootRefused(how)

      expect(JSON.parse(localStorage.getItem('gym_user'))?.id).toBe(aId)
      expect(localStorage.getItem('gym_owner')).toBe(aId)
      expect(B.getState().user?.id).toBe(aId)
      // Tab 1 stays on A and is not told A's session ended: the browser holds A's new one.
      expect(A.getState().user?.id).toBe(aId)
      expect(A.getState().sync.lastError?.code).not.toBe('auth')
      expect(A.getState().sync.status).not.toBe('auth')
    })
  }

  it('NATG-574: a boot 401 with the owner unchanged still signs this tab out', async () => {
    const gen = localStorage.getItem('gym_owner_gen')
    const { A, aId } = await bootRefused({ toB: false })

    expect(localStorage.getItem('gym_user')).toBeNull()
    expect(A.getState().user).toBeNull()
    expect(A.getState().sync).toMatchObject({ status: 'auth', lastError: { status: 401 } })
    // The copy stays with its owner, for A signing in again (adoptProfile).
    expect(localStorage.getItem('gym_owner')).toBe(aId)
    expect(ids(saved())).toEqual(['x1', 'x2', 'x3'])
    // A 401 only drops this tab's user: no sign-in or sign-out, so no new token (NATG-606).
    expect(localStorage.getItem('gym_owner_gen')).toBe(gen)
  })

  // NATG-606: boot's own setUser for the owner already here is no sign-in. Were it to rewrite the
  // token, boot's last check (a 401 from its pull) would always find it moved and never sign out.
  // A browser without the token yet (opened before this was deployed) is not given one either.
  for (const gen of ['g-before', null]) {
    it(`NATG-606: a boot that signs A back in leaves the sign-in token ${gen ? 'as it was' : 'unset'}`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const aId = OWNER
      const aDoc = { ...account(), _rev: 3, _wid: aId + '-w3', _wids: [aId + '-w2'] }
      const srv = accounts({ [aId]: aDoc })
      srv.session = aId
      localStorage.setItem('gym_owner', aId)
      if (gen) localStorage.setItem('gym_owner_gen', gen)
      localStorage.setItem('gym_user', JSON.stringify({ id: aId, name: 'Xavi' }))
      const S = clone(aDoc); delete S._rev
      localStorage.setItem('gym_state_v1', JSON.stringify(S))
      localStorage.setItem('gym_sync', JSON.stringify({ rev: 3, ts: S._ts, wid: aId + '-w3', uid: aId }))
      const A = await openTab({ id: aId, name: 'Xavi' })
      A.setState({ ready: false })

      await act(A, () => A.getState().boot())
      await act(A, settleTicks)

      expect(A.getState().user?.id).toBe(aId)
      expect(localStorage.getItem('gym_owner_gen')).toBe(gen)
    })
  }
})

// NATG-530: the NATG-528 window reached from a local edit instead of a late answer. The other tab
// has moved the owner key, this tab's storage event for it is still queued, and the user changes
// something here. The save went through, wrote the previous account's copy under the new owner
// and moved this tab's idea of the owner along, so the queued event found nothing to clear and
// the push the edit scheduled sent that copy under the new session 1.5 s later.
describe('an edit saved before this tab has heard that the other tab changed the owner', () => {
  // recordPuts is started once the owner has moved: the sign-out's own last push of the account
  // (settle) is the one that should go.
  // `change` runs as tab A while its storage callbacks wait, in order, for it to finish; then the
  // queued callbacks run, as the browser delivers them, and the push debounce has its chance.
  const editBeforeHearing = async (A, switchOwner, change) => {
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++
    try {
      await switchOwner()
      writer = tabA
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      change()
    } finally { writer = null; tabA.busy-- }
    try {
      pump()
      await vi.advanceTimersByTimeAsync(2000)
    } finally { vi.useRealTimers() }
  }
  const stashedEntries = () => Object.values(JSON.parse(localStorage.getItem('gym_stash') || '{}'))
  const stashed = () => stashedEntries().map(e => e.state)

  it('after a sign-out: nothing of the account is saved or pushed, and the tab still hands over', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    const puts = []

    await editBeforeHearing(A, async () => {
      await act(B, () => B.getState().signOut())
      recordPuts(puts)
      expect(localStorage.getItem('gym_owner')).toBeNull()
      expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
    }, () => A.getState().update(s => { s.restSec = 45 }))

    // Nothing of the account is saved in the browser, nor kept aside: on this path the edit was
    // made on the account's whole copy.
    expect(A.getState().S.restSec).toBe(DEF.restSec)
    expect(saved().restSec).toBe(DEF.restSec)
    expect(ids(saved())).toEqual([])
    expect(saved().routines).toEqual([])
    expect(saved().bodyweight).toEqual([])
    expect(localStorage.getItem('gym_sync')).toBeNull()
    expect(stashed().flatMap(ids)).toEqual([])
    // Nor sent.
    expect(puts).toEqual([])
    // The tab hands over as it does when the event comes first.
    expect(A.getState().user).toBeNull()
    expect(ids(A.getState().S)).toEqual([])
    expect(A.getState().S.routines).toEqual([])
    const G = await openTab(null)   // a fresh signed-out tab
    expect(ids(G.getState().S)).toEqual([])
    // The next account signing in here is not asked about the signed-out account's workouts.
    server({ ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 2 })
    await act(G, () => G.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
    const pre = JSON.parse(localStorage.getItem('gym_adopt') || 'null')?.pre
    expect(pre?.workouts || []).toEqual([])
    expect(pre?.routines || []).toEqual([])
  })

  it('after a sign-in to another account: nothing of the old account is saved or pushed, and the tab takes the new one', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    srv.doc = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }   // the server now answers as Yan
    const puts = []
    recordPuts(puts)

    await editBeforeHearing(A, async () => {
      await act(B, () => B.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
      expect(localStorage.getItem('gym_owner')).toBe('Y-' + OWNER)
      expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
    }, () => A.getState().update(s => { s.restSec = 45 }))

    // Nothing of the old account is saved under the new owner, nor kept aside as this device's: the
    // only place its copy may stay is under its own id, where the sign-in itself keeps what it owes
    // (keepForPrevious).
    expect(A.getState().S.restSec).toBe(DEF.restSec)
    expect(saved().restSec).toBe(DEF.restSec)
    expect(ids(saved())).toEqual([])
    expect(saved().routines || []).toEqual([])
    expect(stashedEntries().filter(e => e.uid !== OWNER && ids(e.state).includes('x1'))).toEqual([])
    const pre = JSON.parse(localStorage.getItem('gym_adopt')).pre
    expect(pre.workouts || []).toEqual([])
    expect(pre.routines || []).toEqual([])
    // Nor sent.
    expect(puts).toEqual([])
    // The tab hands over as it does when the event comes first.
    expect(A.getState().user).toBeNull()
    expect(ids(A.getState().S)).toEqual([])

    await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
    expect(ids(srv.doc)).toEqual(['yW1'])
    expect(srv.doc.routines || []).toEqual([])
    expect(puts.some(({ state: s }) => ids(s).includes('x1') || (s.routines || []).length)).toBe(false)
    // A follows the sign-in like any tab the owner changed under.
    expect(ids(A.getState().S)).toEqual(['yW1'])
  })
})

// NATG-541: the other order. The edit comes first and its push waits in the 1.5 s debounce; then
// the other tab moves the owner key, and the timer fires while this tab's storage event for it is
// still queued, so the store still names the previous account. A push sent then carried that
// account's copy under whichever session the browser holds now.
describe('a push waiting in the debounce when the other tab changes the owner', () => {
  // Tab A edits (restSec 45), and the push waits in the debounce. `switchOwner` runs while A's
  // storage callbacks wait, then `send` while they still wait: by default the clock passes the
  // debounce. Then they run, as the browser delivers them once tab 1 is free.
  const editThenSwitch = async (A, switchOwner, send = () => vi.advanceTimersByTimeAsync(2000)) => {
    const tabA = tabs.find(x => x.store === A)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(A, () => A.getState().update(s => { s.restSec = 45 }))
      tabA.busy++
      try {
        await switchOwner()
        writer = tabA
        await send()
      } finally { writer = null; tabA.busy-- }
      pump()
      await vi.advanceTimersByTimeAsync(2000)
    } finally { vi.useRealTimers() }
  }
  // Two tabs signed in as Xavi, holding the server's copy at revision 1.
  const twoTabs = async srv => {
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    return { A, B, tabA: tabs.find(x => x.store === A) }
  }

  it('after a sign-out: the waiting push is not sent, and the tab hands over', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    const { A, B } = await twoTabs(srv)
    const puts = []

    await editThenSwitch(A, async () => {
      // The sign-out's own last push of the account (settle) is the one that should go.
      await act(B, () => B.getState().signOut())
      recordPuts(puts)
      expect(localStorage.getItem('gym_owner')).toBeNull()
      expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
    })

    expect(puts).toEqual([])
    expect(A.getState().user).toBeNull()
    expect(ids(A.getState().S)).toEqual([])
    expect(ids(saved())).toEqual([])
    expect(localStorage.getItem('gym_sync')).toBeNull()
  })

  it('after a sign-in to another account: the waiting push is not sent under the new session', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    const { A, B } = await twoTabs(srv)
    const yan = 'Y-' + OWNER
    const puts = []

    await editThenSwitch(A, async () => {
      srv.doc = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }   // the server now answers as Yan
      recordPuts(puts)
      await act(B, () => B.getState().setUser({ id: yan, name: 'Yan' }, { adopt: true }))
      expect(localStorage.getItem('gym_owner')).toBe(yan)
      expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
    })

    expect(puts).toEqual([])
    expect(ids(srv.doc)).toEqual(['yW1'])
    expect(srv.doc._rev).toBe(4)
    expect(A.getState().user).toBeNull()
    expect(ids(A.getState().S)).toEqual([])
    expect(ids(saved())).toEqual([])
  })

  // The exception NATG-530 makes: an owner key that has moved back to the account this tab is
  // signed in as (the other tab signed out and in again as Xavi) is not another owner, and the
  // push goes. The sign-out's settle already sent the edit (revision 2); A's own push is the one
  // sent against the revision A holds (1), refused and retried after the merge.
  it('after the other tab signed out and back in as the same account: the waiting push still goes', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    const { A, B } = await twoTabs(srv)
    const puts = []

    await editThenSwitch(A, async () => {
      await act(B, () => B.getState().signOut())
      recordPuts(puts)
      await act(B, () => B.getState().setUser({ id: OWNER, name: 'Xavi' }, { adopt: true }))
      expect(localStorage.getItem('gym_owner')).toBe(OWNER)
      expect(A.getState().user?.id).toBe(OWNER)
    })

    // Only A's push, and its retry after the 409 merge: B pushes nothing while its question is open.
    expect(puts.map(p => p.baseRev)).toEqual([1, 2])
    const own = puts.filter(p => p.baseRev === 1)
    expect(own).toHaveLength(1)
    expect(own[0].state.restSec).toBe(45)
    expect(ids(own[0].state)).toEqual(['x1', 'x2', 'x3'])
    expect(srv.doc.restSec).toBe(45)
    expect(ids(srv.doc)).toEqual(['x1', 'x2', 'x3'])
  })

  /* NATG-577: the waiting push sent before its timer fires. Leaving the page (pagehide), hiding it
     (visibilitychange) and a pull each send a push still waiting in the debounce straight away, and
     none of them passes the timer's own check, so the check in doPush() is the only one between
     them and the PUT. Each runs in tab A after the owner has moved and before A has heard. */
  const sends = {
    pagehide: async () => {
      window.dispatchEvent(new Event('pagehide'))
      await vi.advanceTimersByTimeAsync(0)
    },
    'visibilitychange (hidden)': async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      try { document.dispatchEvent(new Event('visibilitychange')) } finally { delete document.visibilityState }
      await vi.advanceTimersByTimeAsync(0)
    },
    pullState: A => A.getState().pullState(),
  }
  // Each owner change tab B makes (`switchOwner`), and what it leaves on the server besides
  // (`kept`): Yan's document as it was.
  const moves = {
    'a sign-out': {
      switchOwner: async (B, srv, puts) => {
        await act(B, () => B.getState().signOut())   // its settle's own push of the account should go
        recordPuts(puts)
      },
      kept: () => {},
    },
    'a sign-in to another account': {
      switchOwner: async (B, srv, puts) => {
        srv.doc = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }   // the server now answers as Yan
        recordPuts(puts)
        await act(B, () => B.getState().setUser({ id: 'Y-' + OWNER, name: 'Yan' }, { adopt: true }))
      },
      kept: srv => {
        expect(ids(srv.doc)).toEqual(['yW1'])
        expect(srv.doc._rev).toBe(4)
      },
    },
  }
  for (const [via, send] of Object.entries(sends)) {
    for (const [move, { switchOwner }] of Object.entries(moves)) {
      it(`${via} after ${move} in the other tab: the waiting push is not sent`, async () => {
        DEF = (await import('./useStore.js')).DEF
        const srv = server({ ...account(), _rev: 1 })
        const { A, B } = await twoTabs(srv)
        const puts = []

        await editThenSwitch(A, async () => {
          await switchOwner(B, srv, puts)
          expect(localStorage.getItem('gym_owner')).not.toBe(OWNER)
          expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
        }, () => send(A))

        expect(puts).toEqual([])
        expect(A.getState().user).toBeNull()
        expect(ids(A.getState().S)).toEqual([])
      })
    }
  }

  /* Sends that resume after an await: an answer A was waiting for lands, or a pull A's own
     sign-out was waiting for, after the other tab has moved the owner and before A has heard.
     The request is held with hold(method), so its answer lands only on `release()`. */
  // `switchOwner` runs while A's storage callbacks wait, then `resume` as A while they still wait;
  // then they run, and the clock is given the chance to start anything left (the debounce, a
  // follow-up).
  const thenResume = async (tabA, switchOwner, resume) => {
    tabA.busy++
    try {
      await switchOwner()
      writer = tabA
      await resume()
    } finally { writer = null; tabA.busy-- }
    pump()
    await vi.advanceTimersByTimeAsync(2000)
  }

  for (const [move, { switchOwner, kept }] of Object.entries(moves)) {
    // AC2: a second edit's push, asked for while the first is still on its way, waits behind it
    // (pushAgain). The other tab moves the owner before the first one's answer lands: the
    // follow-up is for Xavi, and does not go.
    it(`a follow-up push queued behind one in flight is not sent after ${move} in the other tab`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const srv = server({ ...account(), _rev: 1 })
      const { A, B, tabA } = await twoTabs(srv)
      const held = hold('PUT')
      const puts = []

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await act(A, () => A.getState().update(s => { s.restSec = 45 }))
        await vi.advanceTimersByTimeAsync(2000)
        await held.asked   // the first push is out
        await act(A, () => A.getState().update(s => { s.restSec = 50 }))
        await vi.advanceTimersByTimeAsync(2000)   // its push asked for while the first is in flight
        await thenResume(tabA, async () => {
          await switchOwner(B, srv, puts)
          expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
        }, async () => { held.release(); await vi.advanceTimersByTimeAsync(2000) })
      } finally { vi.useRealTimers() }

      expect(puts).toEqual([])
      kept(srv)
      expect(A.getState().user).toBeNull()
      expect(ids(A.getState().S)).toEqual([])
    })

    // AC2: the push's 409, carrying Xavi's newer document, lands after the move. Merged and
    // retried, the retry went out for Xavi under whatever session the browser holds now.
    it(`a conflict answer landing after ${move} in the other tab is not merged and retried`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const srv = server({ ...account(), _rev: 1 })
      const { A, B, tabA } = await twoTabs(srv)
      srv.doc = { ...srv.doc, routines: [routine('xr'), routine('xr-newer')], _ts: 200, _rev: 2 }   // another device's edit: A's push gets a 409
      const held = hold('PUT')
      const puts = []

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await act(A, () => A.getState().update(s => { s.restSec = 45 }))
        await vi.advanceTimersByTimeAsync(2000)
        await held.asked   // refused, and the refusal on its way back
        await thenResume(tabA, async () => {
          await switchOwner(B, srv, puts)
          expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
        }, async () => { held.release(); await vi.advanceTimersByTimeAsync(2000) })
      } finally { vi.useRealTimers() }

      expect(puts).toEqual([])
      kept(srv)
      expect(A.getState().user).toBeNull()
      expect(ids(A.getState().S)).toEqual([])
      expect(A.getState().S.routines).toEqual([])
    })

    // A signs out itself while its pull is on its way, with a change made after the pull left.
    // The sign-out waits for the pull (settle), then pushes the change it owes. The other tab moves
    // the owner before the pull's answer lands: that push is for Xavi, and does not go. Without the
    // change the sign-out owes nothing and has no push to drop (NATG-573).
    it(`A's own sign-out waiting on a pull sends nothing after ${move} in the other tab`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const srv = server({ ...account(), _rev: 1 })
      const { A, B, tabA } = await twoTabs(srv)
      const held = hold('GET')
      const puts = []

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const pull = A.getState().pullState()
        await held.asked
        await act(A, () => A.getState().update(s => { s.restSec = 45 }))   // owed: the pull has left without it
        let signingOut
        await thenResume(tabA, async () => {
          // Only signOut()'s synchronous start is A's (settle() can write before it awaits the pull); the rest runs in `resume`, as A.
          writer = tabA
          signingOut = A.getState().signOut()   // waits for the pull
          writer = null
          await switchOwner(B, srv, puts)
          expect(A.getState().user?.id).toBe(OWNER)   // not heard of yet
        }, async () => {
          held.release()
          await vi.advanceTimersByTimeAsync(2000)
          await pull
          await signingOut
        })
      } finally { vi.useRealTimers() }

      expect(puts).toEqual([])
      kept(srv)
      expect(A.getState().user).toBeNull()
      expect(ids(A.getState().S)).toEqual([])
    })
  }
})

describe('a reset or import refused before this tab has heard that the other tab changed the owner', () => {
  /* NATG-570. A reset or an import arms its replace (no baseRev, or the revision it read) before
     its save, and the save is the one refused: the owner moved. The tab then takes the new
     account's copy, and the replace, left armed, went out with that account's next ordinary
     change, over what another device had synced to it. Tab B signs in as Yan and keeps Yan's
     profile while A's storage callbacks wait; the account A held is at revision 5, Yan at 4.
     `replace` runs as A in that window, and `inWindow` checks A before its queued events run. */
  const refusedThenEdit = async (replace, inWindow) => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 5 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 5)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    const tabA = tabs.find(x => x.store === A)
    const yan = 'Y-' + OWNER
    tabA.busy++
    try {
      srv.doc = { ...clone(DEF), _ts: 500, workouts: [w('yW1', '2026-09-05')], _rev: 4 }   // the server now answers as Yan
      await act(B, () => B.getState().setUser({ id: yan, name: 'Yan' }, { adopt: true }))
      await act(B, () => B.getState().adoptProfile(async () => false))   // "Keep profile as is"
      tabs.find(x => x.store === B).busy++   // B writes nothing more: A is the only writer from here
      writer = tabA
      inWindow(A, await replace(A), yan)
    } finally { writer = null; tabA.busy--; pump() }
    // Either way A has handed over to Yan's copy as it is.
    expect(A.getState().user?.id).toBe(yan)
    expect(ids(A.getState().S)).toEqual(['yW1'])
    // Another device syncs a workout to Yan's profile; A has not pulled it.
    srv.doc = { ...srv.doc, _rev: 5, _ts: Date.now() + 100, workouts: [...srv.doc.workouts, w('yOther', '2026-09-06')] }
    const bases = []
    const answer = h.api
    h.api = (path, opts = {}) => {
      if (opts.method === 'PUT' && path === '/api/data') bases.push(JSON.parse(opts.body).baseRev ?? null)
      return answer(path, opts)
    }
    h.toasts = []
    await act(A, () => A.getState().update(s => { s.restSec = 75 }))
    await act(A, () => A.getState().pushState())
    return { srv, bases }
  }

  it('a refused reset leaves no replace behind: the next account\'s change goes against its own revision', async () => {
    const { srv, bases } = await refusedThenEdit(A => A.getState().resetEverything(), (A, _, yan) => {
      // The reset's own save was refused, and was the handover.
      expect(A.getState().user?.id).toBe(yan)
      expect(ids(A.getState().S)).toEqual(['yW1'])
    })
    // Yan's revision, then the merge's retry; not a replace without one.
    expect(bases).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
  })

  /* Since NATG-535 an import holds a token of the account it was begun for, and one without (or
     with one taken before the owner moved) is refused before it arms anything. So this no longer
     reaches the replace NATG-570 is about: it guards that refusal, and the clear of replaceRev in
     handOver() stays as a defensive one. The reset above is the test of the fix. */
  it('a refused import leaves no replace behind: the previous account\'s revision does not go out with the next one\'s change', async () => {
    const { srv, bases } = await refusedThenEdit(A => A.getState().importBackup({ ...clone(DEF), workouts: [w('b1', '2026-08-01')] }), (A, done) => {
      // Refused before any save: A hands over only when its queued owner event runs.
      expect(done).toBe(false)
      expect(A.getState().user?.id).toBe(OWNER)
    })
    // Not the previous account's revision 5, which Yan's document has just reached too.
    expect(bases).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
    expect(h.toasts.some(m => /while you were importing/.test(m))).toBe(false)
  })
})

describe('a reset or import followed, before its push, by this tab signing in to another account', () => {
  /* NATG-572. A reset or an import arms its replace (no baseRev, or the revision it read) and
     queues its push. Before the 1.5 s debounce fires, this same tab signs in to another account,
     the way a device link does (Passkeys: setUser with `adopt` while signed in). The sign-in drops
     the queued push, and the replace, left armed, went out with the new account's next change,
     over what another device had synced to it. The account this tab held is at revision 5, Yan at
     4; another device then takes Yan to 5. */
  const signInBeforePush = async replace => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 5 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 5)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const puts = []
    recordPuts(puts)
    await act(A, () => replace(A))
    expect(puts).toEqual([])   // still in the debounce
    const yan = 'Y-' + OWNER
    srv.doc = { ...clone(DEF), _ts: 500, workouts: [w('yW1', '2026-09-05')], _rev: 4 }   // the server now answers as Yan
    await act(A, () => A.getState().setUser({ id: yan, name: 'Yan' }, { adopt: { alwaysAsk: true } }))
    await act(A, () => A.getState().adoptProfile(async () => false, { alwaysAsk: true }))
    expect(A.getState().user?.id).toBe(yan)
    expect(ids(A.getState().S)).toEqual(['yW1'])
    // Another device syncs a workout to Yan's profile; A has not pulled it.
    srv.doc = { ...srv.doc, _rev: 5, _ts: Date.now() + 100, workouts: [...srv.doc.workouts, w('yOther', '2026-09-06')] }
    h.toasts = []
    await act(A, () => A.getState().update(s => { s.restSec = 75 }))
    await act(A, () => A.getState().pushState())
    return { srv, bases: puts.map(p => p.baseRev) }
  }

  it('a reset leaves no replace behind: the next account\'s change goes against its own revision', async () => {
    const { srv, bases } = await signInBeforePush(A => A.getState().resetEverything())
    // Yan's revision, then the merge's retry; not a replace without one.
    expect(bases).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
  })

  it('an import leaves no replace behind: the previous account\'s revision does not go out with the next one\'s change', async () => {
    const backup = { ...clone(DEF), workouts: [w('b1', '2026-08-01')] }
    const { srv, bases } = await signInBeforePush(async A => {
      const token = A.getState().importToken()
      expect(await A.getState().importConflict(backup, token)).not.toBeNull()   // the check read revision 5
      expect(A.getState().importBackup(backup, { token })).toBe(true)
    })
    // Not the previous account's revision 5, which Yan's document has just reached too.
    expect(bases).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
    expect(h.toasts.some(m => /while you were importing/.test(m))).toBe(false)
  })

  it('with no sign-in in between, the reset still goes out as a replace of the account\'s copy', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 5 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 5)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const puts = []
    recordPuts(puts)
    await act(A, () => A.getState().resetEverything())
    await act(A, () => A.getState().pushState())
    // Against the revision its own read of the profile returned, never without one (NATG-655).
    expect(puts.map(p => p.baseRev)).toEqual([5])
    expect(ids(srv.doc)).toEqual([])
  })
})

// NATG-564 (NATG-532's real password UI, 3 trials in 20): tab 2 signs in as Yan while tab 1, which
// it signs out, is still busy. The browser told tab 1 of Yan's final save only once tab 2 had also
// written its marker. Tab 1 had already taken tab 2's provisional copy, in step with no revision,
// as Yan's and stopped waiting: it then joined that copy's fresh-profile settings into Yan's final
// save, and saving the join dropped Yan's marker. Tab 1 stayed signed out over Yan's data, and tab
// 2 took the join back with no base and pushed it unconditionally.
describe('a signed-out tab while the other tab finishes signing in to another account', () => {
  const orders = {
    // The browser's order: tab 1 hears of the final save and the marker only after tab 2 is done.
    'tab 1 still busy while tab 2 answers the question': async (A, answer) => {
      const tabA = tabs.find(x => x.store === A)
      tabA.busy++
      try { await answer() } finally { tabA.busy-- }
      pump()
    },
    // Each write told to tab 1 the moment it is made.
    'tab 1 hearing of each write as it is made': async (A, answer) => { await answer() },
  }
  for (const [order, deliver] of Object.entries(orders)) {
    it(`${order}: tab 1 ends signed in as Yan, and Yan's marker, settings and base revision stay`, async () => {
      DEF = (await import('./useStore.js')).DEF
      const srv = server({ ...account(), _rev: 1 })
      localStorage.setItem('gym_owner', OWNER)
      savedCopy(srv.doc, 1)
      const A = await openTab({ id: OWNER, name: 'Xavi' })
      const B = await openTab({ id: OWNER, name: 'Xavi' })
      const yanId = 'Y-' + OWNER
      srv.doc = { ...clone(DEF), _ts: 50, lang: 'de', gifSize: 'full', weighIn: true, workouts: [w('yW1', '2026-09-05')], _rev: 4 }
      const yanSettings = { lang: 'de', gifSize: 'full', weighIn: true }
      const puts = []
      recordPuts(puts)

      await act(B, () => B.getState().setUser({ id: yanId, name: 'Yan' }, { adopt: true }))
      expect(A.getState().user).toBeNull()
      await deliver(A, () => act(B, () => B.getState().adoptProfile(async () => false)))   // "Keep profile as is"

      // Tab 1 follows the sign-in and shows Yan's copy.
      expect(A.getState().user?.id).toBe(yanId)
      expect(ids(A.getState().S)).toEqual(['yW1'])
      // Yan's marker is still where tab 2 wrote it.
      expect(JSON.parse(localStorage.getItem('gym_sync'))?.rev).toBe(srv.doc._rev)
      // Yan's settings, on the server and in the saved copy, are Yan's.
      for (const [k, v] of Object.entries(yanSettings)) {
        expect(srv.doc[k]).toBe(v)
        expect(saved()[k]).toBe(v)
      }
      // Every push in the sequence is conditional, a later one from either tab included.
      await act(B, () => B.getState().update(s => { s.restSec = 75 }))
      await act(B, () => B.getState().pushState())
      await act(A, () => A.getState().update(s => { s.restPauseSec = 20 }))
      await act(A, () => A.getState().pushState())
      expect(puts.length).toBeGreaterThan(0)
      expect(puts.filter(p => p.baseRev == null)).toEqual([])
      expect(srv.doc.restSec).toBe(75)
      expect(srv.doc.restPauseSec).toBe(20)
      expect(ids(srv.doc)).toEqual(['yW1'])
    })
  }
})

// The handover above ends once the tab follows the sign-in. A tab already signed in as the account
// the owner moved to has nothing to follow (followSignIn wants a tab with no user): its handover
// ends as it takes that account's copy, or it went on refusing every save it was asked for.
describe('a tab already signed in as the account the other tab makes the owner', () => {
  it('takes the account\'s copy and goes on saving and pushing its own changes', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server(null)
    const xavi = { id: OWNER, name: 'Xavi' }
    // Loaded with the account's user but no owner recorded beside the copy (a guest's copy).
    localStorage.setItem('gym_state_v1', JSON.stringify({ ...clone(DEF), _ts: Date.now(), workouts: [w('gW1', '2026-09-04')] }))
    localStorage.setItem('gym_user', JSON.stringify(xavi))
    const A = await openTab(xavi)
    const B = await openTab(null)

    // Register in tab 2 (views/Login.jsx): the copy becomes Xavi's, saved under him, then pushed.
    await act(B, () => B.getState().setUser(xavi))
    await act(B, () => B.getState().pushState())
    expect(A.getState().user?.id).toBe(OWNER)
    expect(ids(A.getState().S)).toEqual(['gW1'])

    await act(A, () => A.getState().update(s => { s.restSec = 45 }))
    expect(saved().restSec).toBe(45)
    expect(JSON.parse(localStorage.getItem('gym_stash') || '{}')).toEqual({})
    await act(A, () => A.getState().pushState())
    expect(srv.doc.restSec).toBe(45)
    expect(ids(srv.doc)).toEqual(['gW1'])
  })
})

/* NATG-581. Tab A signs out as Xavi, or signs out everywhere, and waits (here on a pull still on
   its way); meanwhile tab B signs in as Yan. The logout A then sent went out under Yan's session
   and took Yan's owner key with it: Yan was signed out without a word, and by "everywhere" on
   every device. A sign-out overtaken by a different account now changes nothing: no logout, the
   owner key stays Yan's, and the result is { cancelled: true }. Tab A has handed over to Yan by
   the time it returns. An owner gone to nobody (B signed Xavi out) is not another account, and a
   sign-out started once A follows Yan signs Yan out, both as before. */
describe('a sign-out overtaken by another tab signing in as a different account', () => {
  const yan = () => 'Y-' + OWNER
  // Two tabs signed in as Xavi at revision 1, and the browser's session as the server sees it:
  // Xavi's, Yan's once B signs in, nobody's after a logout. `logouts`: each one, with whose
  // session it went out under.
  const setup = async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    localStorage.setItem('gym_owner_name', 'Xavi')
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })
    const net = { session: OWNER, logouts: [] }
    const answer = h.api
    h.api = async (path, opts = {}) => {
      if (opts.method === 'POST' && path.startsWith('/api/logout')) { net.logouts.push({ path, who: net.session }); net.session = null }
      return answer(path, opts)
    }
    return { srv, net, A, B, tabA: tabs.find(x => x.store === A), tabB: tabs.find(x => x.store === B) }
  }
  // B signs in as Yan (its sign-in sets the user; the profile question comes after).
  const yanSignsIn = (B, srv, net) => {
    net.session = yan()
    srv.doc = { ...clone(DEF), _ts: 50, workouts: [w('yW1', '2026-09-05')], _rev: 4 }
    B.getState().setUser({ id: yan(), name: 'Yan' }, { adopt: true })
  }
  const nothingHappened = ({ srv, net, A }, r) => {
    expect(r).toEqual({ cancelled: true })
    expect(net.logouts).toEqual([])
    expect(net.session).toBe(yan())
    expect(localStorage.getItem('gym_owner')).toBe(yan())
    expect(localStorage.getItem('gym_owner_name')).toBe('Yan')
    expect(A.getState().user).toBeNull()   // handed over: nothing of Xavi is left in tab A
    expect(ids(srv.doc)).toEqual(['yW1'])
    expect(srv.doc._rev).toBe(4)
  }
  // A's sign-out waits on A's pull; B signs in as Yan before the pull's answer lands. `heard`:
  // whether A's storage event for the new owner has run by then, or is still queued.
  const overtakenWhileWaiting = async (t, action, heard) => {
    const { srv, net, A, B, tabA } = t
    const held = hold('GET')
    const pull = A.getState().pullState()
    await held.asked
    if (!heard) tabA.busy++
    try {
      writer = tabA
      const leaving = A.getState()[action]()   // waits for the pull
      writer = null
      await act(B, () => yanSignsIn(B, srv, net))
      expect(A.getState().user?.id ?? null).toBe(heard ? null : OWNER)
      expect(net.logouts).toEqual([])
      writer = tabA
      held.release()
      await pull
      return await leaving
    } finally { writer = null; if (!heard) tabA.busy--; pump() }
  }

  for (const action of ['signOut', 'signOutAll']) {
    for (const heard of [false, true]) {
      it(`${action} waiting on a pull, B signs in as Yan ${heard ? 'and A has heard' : 'before A has heard'}: cancelled, Yan stays signed in`, async () => {
        const t = await setup()
        const r = await overtakenWhileWaiting(t, action, heard)
        nothingHappened(t, r)
        // Tab A then follows Yan, as it does whenever another tab signs someone in.
        await act(t.B, () => t.B.getState().adoptProfile(async () => false))
        expect(t.A.getState().user?.id).toBe(yan())
        expect(ids(t.A.getState().S)).toEqual(['yW1'])
      })
    }

    // The check runs right before the logout, not only after settle(): here B signs in once the
    // pull has settled, while A stops its timers.
    it(`${action}: B signs in as Yan after the sign-out has settled and before its logout goes: cancelled`, async () => {
      const t = await setup()
      const { srv, net, A, B, tabB } = t
      h.onStop = () => {
        const prev = writer
        writer = tabB
        try { yanSignsIn(B, srv, net) } finally { writer = prev }
      }
      let r
      try { r = await act(A, () => A.getState()[action]()) } finally { h.onStop = null }
      nothingHappened(t, r)
    })

    // AC5: started after the switch, once tab A follows Yan, it is Yan's own sign-out.
    it(`${action} started after B signed in as Yan, once A follows Yan, signs Yan out as before`, async () => {
      const { srv, net, A, B } = await setup()
      await act(B, () => yanSignsIn(B, srv, net))
      await act(B, () => B.getState().adoptProfile(async () => false))
      expect(A.getState().user?.id).toBe(yan())
      const r = await act(A, () => A.getState()[action]())
      expect(r).toEqual({ owed: false })
      expect(net.logouts).toEqual([{ path: action === 'signOut' ? '/api/logout' : '/api/logout/all', who: yan() }])
      expect(localStorage.getItem('gym_owner')).toBeNull()
      expect(A.getState().user).toBeNull()
    })

    // Not another account: B signed Xavi out while A waited. A's sign-out goes on as before.
    it(`${action} waiting on a pull, B signs Xavi out meanwhile: not cancelled, it finishes as before`, async () => {
      const { net, A, B, tabA } = await setup()
      const held = hold('GET')
      const pull = A.getState().pullState()
      await held.asked
      let r
      try {
        writer = tabA
        const leaving = A.getState()[action]()
        writer = null
        await act(B, () => B.getState().signOut())
        expect(localStorage.getItem('gym_owner')).toBeNull()
        writer = tabA
        held.release()
        await pull
        r = await leaving
      } finally { writer = null; pump() }
      expect(r).toEqual({ owed: false })
      expect(net.logouts.map(x => x.path)).toEqual(['/api/logout', action === 'signOut' ? '/api/logout' : '/api/logout/all'])
      expect(localStorage.getItem('gym_owner')).toBeNull()
      expect(A.getState().user).toBeNull()
    })
  }

  // AC4: the phone's disconnect hands the cancelled result back and stays paired: no switch to
  // local-only (setGuest), no forgetting the server.
  it('disconnectServer overtaken the same way: cancelled, and nothing switches to local-only', async () => {
    const t = await setup()
    const r = await overtakenWhileWaiting(t, 'disconnectServer', false)
    nothingHappened(t, r)
    expect(localStorage.getItem('gym_guest')).toBeNull()
  })
})

/* A reset made while a sign-in's adoption is still open (a failed GET leaves it held) arms a replace
   that the hold keeps from going (pushState). An adoption that then takes the server's copy has
   thrown the reset's copy away: the replace armed for it goes too, so the next ordinary edit goes
   against the adopted revision, and a 409 merges what another device wrote since (NATG-596).
   So does an adoption into an account with no profile yet that pushes nothing. An import the
   adoption does push still goes. */
describe('a reset or import made while a sign-in\'s adoption is held', () => {
  const remoteWrites = srv => {
    srv.doc = { ...srv.doc, _rev: srv.doc._rev + 1, _ts: Date.now() + 100, workouts: [...srv.doc.workouts, w('yOther')] }
  }

  it('reset during adoption must not replace a later remote workout', async () => {
    const srv = server({ ...clone(DEF), _ts: 500, workouts: [w('yW1')], _rev: 4 })
    const A = await openTab(null)
    await act(A, () => A.getState().setUser({ id: 'Yan', name: 'Yan' }, { adopt: { alwaysAsk: true } }))
    expect(A.getState().sync.held).toBe(true)
    await act(A, () => A.getState().resetEverything())
    await act(A, () => A.getState().pushState())   // held: sends nothing
    const puts = []
    recordPuts(puts)
    await act(A, () => A.getState().adoptProfile(async () => false, { alwaysAsk: true }))
    expect(A.getState().sync.held).toBe(false)
    expect(ids(A.getState().S)).toEqual(['yW1'])
    expect(puts).toEqual([])
    remoteWrites(srv)
    await act(A, () => A.getState().update(s => { s.restSec = 75 }))
    await act(A, () => A.getState().pushState())
    expect(puts.map(p => p.baseRev)).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
  })

  it('reset during an adoption whose first read failed, resumed later, must not replace a later remote workout', async () => {
    const srv = server({ ...clone(DEF), _ts: 500, workouts: [w('yW1')], _rev: 4 })
    const A = await openTab(null)
    await act(A, () => A.getState().setUser({ id: 'Yan', name: 'Yan' }, { adopt: { alwaysAsk: true } }))
    const online = h.api
    h.api = async () => { throw new Error('offline') }
    await expect(act(A, () => A.getState().adoptProfile(async () => false))).rejects.toThrow('offline')
    expect(A.getState().sync.held).toBe(true)
    h.api = online
    await act(A, () => A.getState().resetEverything())
    await act(A, () => A.getState().pushState())   // held: sends nothing
    const puts = []
    recordPuts(puts)
    await act(A, () => A.getState().resumeAdoption(async () => false))
    expect(A.getState().sync.held).toBe(false)
    expect(ids(A.getState().S)).toEqual(['yW1'])
    expect(puts).toEqual([])
    remoteWrites(srv)
    await act(A, () => A.getState().update(s => { s.restSec = 75 }))
    await act(A, () => A.getState().pushState())
    expect(puts.map(p => p.baseRev)).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
  })

  it('an import during adoption that the adoption pushes still reaches the server', async () => {
    const srv = server({ ...clone(DEF), _ts: 500, workouts: [w('yW1')], _rev: 4 })
    const A = await openTab(null)
    await act(A, () => A.getState().setUser({ id: 'Yan', name: 'Yan' }, { adopt: { alwaysAsk: true } }))
    expect(A.getState().sync.held).toBe(true)
    const token = A.getState().importToken()
    expect(A.getState().importBackup({ ...clone(DEF), workouts: [w('b1', '2026-08-01')] }, { token })).toBe(true)
    await act(A, () => A.getState().pushState())   // held: sends nothing
    const puts = []
    recordPuts(puts)
    await act(A, () => A.getState().adoptProfile(async () => false, { alwaysAsk: true }))
    expect(A.getState().sync.held).toBe(false)
    expect(puts.map(p => p.baseRev)).toEqual([4])
    expect(ids(srv.doc)).toEqual(['b1', 'yW1'])
    remoteWrites(srv)
    await act(A, () => A.getState().update(s => { s.restSec = 75 }))
    await act(A, () => A.getState().pushState())
    expect(puts.map(p => p.baseRev)).toEqual([4, 5, 6])
    expect(ids(srv.doc)).toEqual(['b1', 'yOther', 'yW1'])
    expect(srv.doc.restSec).toBe(75)
  })

  // Another device writes between the adoption's read and its push: the import goes as an ordinary
  // push against the adopted revision and merges on the 409, not as a replace of a fresh read.
  it('an import during adoption, with another device writing after the adoption\'s read, keeps that device\'s workout', async () => {
    const srv = server({ ...clone(DEF), _ts: 500, workouts: [w('yW1')], _rev: 4 })
    const A = await openTab(null)
    await act(A, () => A.getState().setUser({ id: 'Yan', name: 'Yan' }, { adopt: { alwaysAsk: true } }))
    const token = A.getState().importToken()
    expect(A.getState().importBackup({ ...clone(DEF), workouts: [w('b1', '2026-08-01')] }, { token })).toBe(true)
    await act(A, () => A.getState().pushState())   // held: sends nothing
    const puts = []
    recordPuts(puts)
    const answer = h.api
    let read = false
    h.api = async (path, opts = {}) => {
      const r = await answer(path, opts)
      if (!read && (opts.method || 'GET') === 'GET' && path === '/api/data') { read = true; remoteWrites(srv) }
      return r
    }
    await act(A, () => A.getState().adoptProfile(async () => false, { alwaysAsk: true }))
    expect(A.getState().sync.held).toBe(false)
    expect(puts.map(p => p.baseRev)).toEqual([4, 5])
    expect(ids(srv.doc)).toEqual(['b1', 'yOther', 'yW1'])
  })

  it('reset during adoption of an account with no profile yet must not replace a later remote workout', async () => {
    const srv = server(null)
    const A = await openTab(null)
    await act(A, () => A.getState().setUser({ id: 'Yan', name: 'Yan' }, { adopt: { alwaysAsk: true } }))
    await act(A, () => A.getState().resetEverything())
    await act(A, () => A.getState().pushState())   // held: sends nothing
    const puts = []
    recordPuts(puts)
    await act(A, () => A.getState().adoptProfile(async () => false, { alwaysAsk: true }))
    expect(A.getState().sync.held).toBe(false)
    expect(puts).toEqual([])
    srv.doc = { ...clone(DEF), _rev: 1, _ts: Date.now() + 100, workouts: [w('yOther')] }
    await act(A, () => A.getState().update(s => { s.restSec = 75 }))
    await act(A, () => A.getState().pushState())
    expect(puts.map(p => p.baseRev)).toEqual([0, 1])
    expect(ids(srv.doc)).toEqual(['yOther'])
    expect(srv.doc.restSec).toBe(75)
  })
})
