// @vitest-environment happy-dom

/* A second tab of the same browser while the owner of the copy changes in the first (QA round 2,
   2026-10-06). The sign-out wrote its wiped copy while the owner key still named the account, so
   the idle tab joined its whole copy of the account into it: the next guest saw it, and the next
   profile created there uploaded it. A device-link sign-in to another account did the same. And a
   guest tab left open put its workout, routine and default settings into the account after "Keep
   profile as is". Each "tab" is a fresh import of the store sharing one localStorage; the browser's
   storage events are replayed in the order the writes happened, as the browser delivers them. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ api: null, toasts: [] }))
vi.mock('../lib/api.js', () => ({ api: (...a) => h.api(...a), setRemoteAuth: () => {} }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: m => h.toasts.push(m), stopRest: () => {}, abandonWork: () => {} }) } }))

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
  vi.resetModules()
  const tab = { store: null, ls: [], inbox: [], busy: 0 }
  const add = window.addEventListener
  window.addEventListener = function (type, l, o) { if (type === 'storage') tab.ls.push(l); else add.call(this, type, l, o) }
  try {
    const m = await import('./useStore.js')
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
  localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts }))
}

beforeEach(async () => {
  localStorage.clear()
  OWNER = 'o' + (Number(OWNER.slice(1)) + 1)
  DEF = (await import('./useStore.js')).DEF
})
afterEach(() => {
  for (const t of tabs) t.store.setState({ user: null, ready: false })
  tabs = []
  localStorage.clear()
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
  // GET /api/data held after the server has answered, as QA's route did: `release` lets it land.
  const holdPull = srv => {
    const answer = h.api
    const gate = { release: null, asked: null }
    const asked = new Promise(r => { gate.asked = r })
    const released = new Promise(r => { gate.release = r })
    h.api = async (path, opts = {}) => {
      if ((opts.method || 'GET') === 'GET' && path === '/api/data' && gate.asked) {
        const res = await answer(path, opts)   // answered as the account it was sent for
        h.api = answer
        gate.asked(); gate.asked = null
        await released
        return res
      }
      return answer(path, opts)
    }
    return { asked, release: () => gate.release() }
  }

  it('an answer landing after a sign-out in the other tab is dropped, in both tabs and in storage', async () => {
    DEF = (await import('./useStore.js')).DEF
    const srv = server({ ...account(), _rev: 1 })
    localStorage.setItem('gym_owner', OWNER)
    savedCopy(srv.doc, 1)
    const A = await openTab({ id: OWNER, name: 'Xavi' })
    const B = await openTab({ id: OWNER, name: 'Xavi' })

    const held = holdPull(srv)
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

    const held = holdPull(srv)
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
    const answer = h.api
    let asked, release
    const isAsked = new Promise(r => { asked = r })
    const released = new Promise(r => { release = r })
    h.api = async (path, opts = {}) => {
      if (opts.method === 'PUT' && path === '/api/data') {
        h.api = answer
        let err = null
        try { await answer(path, opts) } catch (e) { err = e }
        asked()
        await released
        if (err) throw err
        throw new Error('expected a 409')
      }
      return answer(path, opts)
    }
    const pull = A.getState().pullState()
    await isAsked
    const tabA = tabs.find(x => x.store === A)
    tabA.busy++
    try {
      await act(B, () => B.getState().signOut())
      expect(A.getState().user?.id).toBe(OWNER)
      writer = tabA
      release()
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

    const held = holdPull(srv)
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

    const held = holdPull(srv)
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

    const held = holdPull(srv)
    const pull = A.getState().pullState()
    await held.asked
    held.release()
    await act(A, () => pull)
    expect(A.getState().user?.id).toBe(OWNER)
    expect(A.getState().S.routines.map(r => r.id)).toEqual(['xr', 'xr2'])
    expect(saved().routines.map(r => r.id)).toEqual(['xr', 'xr2'])
  })
})
