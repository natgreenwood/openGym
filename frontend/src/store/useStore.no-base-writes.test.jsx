// @vitest-environment happy-dom

/* NATG-655 (stage 1 of NATG-533): a signed-in client never sends PUT /api/data without a sync
   base. Reset everything, a backup's "Replace anyway" with nothing stored to go against, the first
   upload after registering and an adoption over a profile that read as empty each carry the
   `baseRev` their own read returned. Their 409s land as decided on NATG-533: a reset or replace
   keeps what another device added after the read, and an adoption raced by a profile that
   appeared asks about it once, rather than merging into it unasked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn() }))
const { toast, sheetAsk } = vi.hoisted(() => ({ toast: vi.fn(), sheetAsk: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast }) } }))
// The question an adoption resumed by the store itself asks (resumeAdoption from Sync now or a check).
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: (...a) => sheetAsk(...a) }))

import { api } from '../lib/api.js'
import { DEF, useStore } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const ids = xs => (xs || []).map(x => x.id)
const workout = (id, end, extra = {}) => ({ id, d: '2026-09-20', start: end - 1000, end, entries: [], ...extra })
const conflict = (state, rev) => Object.assign(new Error('conflict'), { status: 409, data: { error: 'conflict', state, rev } })
const netErr = () => new TypeError('Failed to fetch')
const RESET_NOTICE = 'Another device synced while you were resetting, so what it added since was kept.'
const IMPORT_NOTICE = 'Another device synced while you were importing, so its changes were kept next to the backup.'

/* The server as api/server.js keeps it: one document with a revision and a write id. A PUT whose
   baseRev (or baseWid) is not the document's gets 409 with the document. A PUT with no baseRev is
   still taken (stage 2 refuses it), so a test that sees one has found the bug. `after(fn)`: the
   next read is answered, and then another device writes `fn` (between this device's read and
   its PUT). `failReads` / `failPuts`: that many reads or writes fail for lack of network first (a
   failed write is still listed in `puts`, as sent); `readError` makes those reads fail with that
   error instead. */
function server(doc) {
  const s = { doc: doc ? clone(doc) : null, next: null, failReads: 0, failPuts: 0, calls: [], puts: [] }
  s.write = fn => { const d = clone(s.doc || { ...clone(DEF), _ts: 0 }); fn(d); d._rev = (s.doc?._rev || 0) + 1; d._wid = 'wid-' + d._rev; s.doc = d }
  s.after = fn => { s.next = fn }
  api.mockImplementation(async (path, o = {}) => {
    const method = o.method || 'GET'
    s.calls.push(method + ' ' + path)
    if (method === 'GET' && path === '/api/data') {
      if (s.failReads > 0) { s.failReads--; throw (s.readError || netErr)() }
      const answer = { state: s.doc ? clone(s.doc) : null, rev: s.doc?._rev || 0 }
      const fn = s.next
      s.next = null
      if (fn) s.write(fn)
      return answer
    }
    if (method === 'GET' && path === '/api/data/rev') return { rev: s.doc?._rev || 0, wid: s.doc?._wid }
    if (method === 'PUT' && path === '/api/data') {
      const body = JSON.parse(o.body)
      s.puts.push(body)
      if (s.failPuts > 0) { s.failPuts--; throw netErr() }
      const rev = s.doc?._rev || 0
      if (body.baseRev != null && (body.baseRev !== rev || (body.baseWid && s.doc?._wid && body.baseWid !== s.doc._wid))) throw conflict(clone(s.doc), rev)
      const next = clone(body.state)
      delete next.active
      next._rev = rev + 1
      next._wid = 'wid-' + next._rev
      s.doc = next
      return { ok: true, rev: next._rev, wid: next._wid }
    }
    return {}
  })
  return s
}

// Signed in as u1 with this copy. `rev`: the account-stamped base it stands on (NATG-556); none
// when it has no stored base.
const signedIn = (S, rev, wid) => {
  localStorage.setItem('gym_owner', 'u1')
  if (rev != null) localStorage.setItem('gym_sync', JSON.stringify({ rev, ts: S._ts, uid: 'u1', ...(wid ? { wid } : {}) }))
  useStore.setState({ S, user: { id: 'u1', name: 'U' }, ready: true, sync: { offline: false, pending: false, lastSynced: 0 } })
}
const signedOut = () => { useStore.getState().setUser(null); useStore.setState({ S: clone(DEF), user: null, ready: false }) }
const toasts = () => toast.mock.calls.map(([m]) => m)

beforeEach(() => { localStorage.clear(); api.mockReset(); toast.mockReset(); sheetAsk.mockReset(); signedOut() })
afterEach(() => { localStorage.clear(); signedOut() })

const LATER = () => Date.now() + 60_000   // another device's stamp after the read, its clock ahead if anything
const PROFILE = () => ({
  ...clone(DEF), _ts: 100, restSec: 60, week: { 1: ['r1'] },
  workouts: [workout('w1', 50), workout('w2', 60)], routines: [{ id: 'r1', name: 'A', ex: [], _ts: 10 }],
  _rev: 3, _wid: 'wid-3',
})

describe('AC1: Reset everything', () => {
  it('reads the profile first and goes against that read, naming what it held, with no follow-up read', async () => {
    const srv = server({ ...PROFILE(), workouts: [...PROFILE().workouts, workout('w-elsewhere', 70)] })
    const mine = PROFILE(); delete mine._rev; delete mine._wid
    signedIn(mine, 3, 'wid-3')
    useStore.getState().resetEverything()
    await useStore.getState().pushState()

    expect(srv.calls).toEqual(['GET /api/data', 'PUT /api/data'])
    expect(srv.puts).toHaveLength(1)
    expect(srv.puts[0].baseRev).toBe(3)
    expect(srv.puts[0].baseWid).toBe('wid-3')
    // The names come from the read, before the PUT: the workout this device never pulled too.
    expect(srv.puts[0].state.resetIds.workouts).toEqual(['w1', 'w2', 'w-elsewhere'])
    // AC6: with nobody else writing, the reset wipes.
    expect(srv.doc.workouts).toEqual([])
    expect(srv.doc.routines).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('never goes out without a base when its read fails: the next push is an ordinary one against the copy\'s base', async () => {
    const srv = server(PROFILE())
    const mine = PROFILE(); delete mine._rev; delete mine._wid
    signedIn(mine, 3, 'wid-3')
    srv.failReads = 1
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    expect(srv.puts).toEqual([])
    expect(useStore.getState().sync.pending).toBe(true)

    await useStore.getState().pushState()
    expect(srv.puts.map(p => p.baseRev)).toEqual([3])
    expect(srv.doc.workouts).toEqual([])
  })

  it('a 409 keeps what another device added after the read, still wipes what it edited, and the reset\'s settings, plan and unit win', async () => {
    const srv = server(PROFILE())
    const mine = PROFILE(); delete mine._rev; delete mine._wid
    signedIn(mine, 3, 'wid-3')
    // Between the reset's read and its PUT another device adds a workout, edits one the read held,
    // and changes a setting, the plan and the unit, all stamped later than the reset.
    srv.after(d => {
      const at = LATER()
      d._ts = at
      d.workouts.push(workout('w-new', at))
      d.workouts[0] = { ...d.workouts[0], note: 'edited elsewhere', _ts: at, _f: { note: at } }
      d.restSec = 200
      d.week = { 1: ['r1'], 2: ['r1'] }
      d.unit = 'lb'
      d.unitSet = { at, convert: false }
      d.edited = { restSec: at, 'week.2': at }
    })
    useStore.getState().resetEverything()
    await useStore.getState().pushState()

    expect(srv.puts.map(p => p.baseRev)).toEqual([3, 4])   // refused, merged, pushed against the 409's revision
    expect(ids(srv.doc.workouts)).toEqual(['w-new'])
    expect(srv.doc.routines).toEqual([])
    expect(srv.doc.restSec).toBe(DEF.restSec)
    expect(srv.doc.week).toEqual(DEF.week)
    expect(srv.doc.unit).toBe('kg')
    expect(ids(useStore.getState().S.workouts)).toEqual(['w-new'])
    // Its own notice, from the store: not the import's.
    await vi.waitFor(() => expect(toasts()).toEqual([RESET_NOTICE]))   // the store's toast, raised through a lazy import
  })
})

describe('AC2: a backup\'s "Replace anyway" with no stored base', () => {
  // The copy has no base (its marker is gone, or never named the account) and the import's check
  // could not read the server: the replace reads the profile itself before it goes.
  const importWithoutRead = async backup => {
    const token = useStore.getState().importToken()
    expect(await useStore.getState().importConflict(backup, token)).toBeNull()   // the check's read failed
    expect(useStore.getState().importBackup(backup, { token })).toBe(true)
    await useStore.getState().pushState()
  }
  const BACKUP = () => ({
    ...clone(DEF), _ts: 40, restSec: 120,
    workouts: [workout('wBoth', 80, { note: 'backup', feel: 1 }), workout('wGone', 90), workout('b1', 30)],
  })
  const AT_READ = () => ({
    ...clone(DEF), _ts: 100, restSec: 60,
    workouts: [workout('w1', 50), workout('wBoth', 80, { note: 'server', feel: 1 }), workout('wGone', 90)],
    _rev: 3, _wid: 'wid-3',
  })

  it('reads the profile, goes against that read, and replaces it (no forced write)', async () => {
    const srv = server(AT_READ())
    const mine = AT_READ(); delete mine._rev; delete mine._wid
    signedIn(mine)
    srv.failReads = 1
    await importWithoutRead(BACKUP())

    expect(srv.calls).toEqual(['GET /api/data', 'GET /api/data', 'PUT /api/data'])
    expect(srv.puts).toHaveLength(1)
    expect(srv.puts[0].baseRev).toBe(3)
    expect(srv.puts[0].baseWid).toBe('wid-3')
    // AC6: "Replace anyway" replaces.
    expect(ids(srv.doc.workouts).sort()).toEqual(['b1', 'wBoth', 'wGone'])
    expect(srv.doc.workouts.find(w => w.id === 'wBoth').note).toBe('backup')
    expect(srv.doc.restSec).toBe(120)
    expect(toasts()).toEqual([])
  })

  it('a 409 keeps another device\'s additions, its deletes stand, and an entry edited on both sides goes field by field, the later stamp winning', async () => {
    const srv = server(AT_READ())
    const mine = AT_READ(); delete mine._rev; delete mine._wid
    signedIn(mine)
    srv.failReads = 1
    // After the replace's read: another device adds a workout, deletes one the backup holds, and
    // edits wBoth, `feel` with a stamp later than the import's and `note` with one from before it.
    srv.after(d => {
      const at = LATER()
      d._ts = at
      d.workouts.push(workout('wNew', at))
      d.workouts = d.workouts.filter(w => w.id !== 'wGone')
      d.deleted = { workouts: { wGone: at } }
      const both = d.workouts.find(w => w.id === 'wBoth')
      Object.assign(both, { feel: 3, note: 'old edit', _ts: at, _f: { feel: at, note: 1 } })
    })
    await importWithoutRead(BACKUP())

    expect(srv.puts.map(p => p.baseRev)).toEqual([3, 4])
    // w1 was on the profile the replace read and is not in the backup: replaced. wNew came after.
    expect(ids(srv.doc.workouts).sort()).toEqual(['b1', 'wBoth', 'wNew'])
    const both = srv.doc.workouts.find(w => w.id === 'wBoth')
    expect(both.feel).toBe(3)          // the other device's, stamped later
    expect(both.note).toBe('backup')   // the backup's, stamped later than that device's edit
    expect(srv.doc.restSec).toBe(120)
    await vi.waitFor(() => expect(toasts()).toEqual([IMPORT_NOTICE]))   // the store's toast, raised through a lazy import
  })
})

describe('AC3: the first upload of a guest\'s data after registering', () => {
  // Login, Settings and PasswordAuth all register the same way: setUser(u), then pushState()
  // when the device holds data (views/Login.jsx, views/Settings.jsx RegisterInline,
  // components/PasswordAuth.jsx).
  it('goes against the revision the read returned, never without one', async () => {
    const srv = server(null)
    useStore.setState({ S: { ...clone(DEF), _ts: 900, workouts: [workout('g1', 50)] }, ready: true })
    useStore.getState().setUser({ id: 'u1', name: 'U' })
    await useStore.getState().pushState()
    await vi.waitFor(() => expect(srv.puts).toHaveLength(1))

    expect(srv.calls[0]).toBe('GET /api/data')   // read before anything is written
    expect(srv.puts[0].baseRev).toBe(0)
    // AC6: the guest's data lands.
    expect(ids(srv.doc.workouts)).toEqual(['g1'])
  })
})

describe('AC4: adoption over a profile that read as empty', () => {
  const guest = () => ({ ...clone(DEF), _ts: 900, restSec: 120, workouts: [workout('g1', 50)] })
  const OTHER = () => ({ ...clone(DEF), _ts: 500, restSec: 45, workouts: [workout('o1', 40)] })
  const signIn = (opts = {}) => {
    useStore.setState({ S: guest(), ready: true })
    useStore.getState().setUser({ id: 'u1', name: 'U' }, { adopt: opts.alwaysAsk ? { alwaysAsk: true } : true })
  }

  it('goes against the revision the read returned (0), and lands', async () => {
    const srv = server(null)
    signIn()
    const ask = vi.fn()
    expect(await useStore.getState().adoptProfile(ask)).toEqual({ adopted: false, added: false })
    expect(ask).not.toHaveBeenCalled()
    expect(srv.puts.map(p => p.baseRev)).toEqual([0])
    expect(ids(srv.doc.workouts)).toEqual(['g1'])   // AC6
    expect(useStore.getState().sync.held).toBe(false)
  })

  it('a 409 is not merged: the profile that appeared is asked about, once, held meanwhile, and kept as is when declined', async () => {
    const srv = server(null)
    srv.after(d => { Object.assign(d, OTHER()) })   // another device creates the profile after the read
    signIn()
    let during = null
    const ask = vi.fn(async () => {
      during = { held: useStore.getState().sync.held, mark: JSON.parse(localStorage.getItem('gym_adopt')) }
      return false
    })
    const r = await useStore.getState().adoptProfile(ask)

    expect(srv.puts.map(p => p.baseRev)).toEqual([0])   // the one refused write; nothing merged into the profile
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ workouts: 1 }))
    expect(during).toEqual({ held: true, mark: expect.objectContaining({ uid: 'u1' }) })
    expect(ids(srv.doc.workouts)).toEqual(['o1'])
    expect(srv.doc.restSec).toBe(45)
    expect(ids(useStore.getState().S.workouts)).toEqual(['o1'])
    expect(r).toEqual({ adopted: true, added: false })
    expect(useStore.getState().sync.held).toBe(false)
    expect(localStorage.getItem('gym_adopt')).toBeNull()
    expect(await useStore.getState().keptChanges()).toHaveLength(1)   // the device's copy kept aside, as on any "Keep profile as is"
  })

  it('a 409 answered "Add them" adds the device\'s entries to that profile, its settings first', async () => {
    const srv = server(null)
    srv.after(d => { Object.assign(d, OTHER()) })
    signIn()
    const ask = vi.fn(async () => true)
    expect(await useStore.getState().adoptProfile(ask)).toEqual({ adopted: true, added: true })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(srv.puts.map(p => p.baseRev)).toEqual([0, 1])
    expect(ids(srv.doc.workouts).sort()).toEqual(['g1', 'o1'])
    expect(srv.doc.restSec).toBe(45)   // the profile's, not the guest's 120
  })

  // QA on PR #94 (Tester finding 1): the write failed on the network, the profile appeared, and
  // the retry went as an ordinary push whose 409 merged the guest's copy into it unasked.
  it('a write that fails on the network keeps the question open: nothing else pushes, and the retry\'s 409 asks once', async () => {
    const srv = server(null)
    signIn()
    srv.failPuts = 1
    const ask = vi.fn()
    expect(await useStore.getState().adoptProfile(ask)).toEqual({ adopted: false, added: false })
    expect(srv.puts.map(p => p.baseRev)).toEqual([0])
    expect(useStore.getState().sync.held).toBe(true)
    expect(JSON.parse(localStorage.getItem('gym_adopt'))).toEqual(expect.objectContaining({ uid: 'u1' }))
    // An ordinary push meanwhile (a debounced edit, a sign-out's settle) sends nothing.
    await useStore.getState().pushState()
    expect(srv.puts).toHaveLength(1)

    // The retry (Sync now) reads no profile yet; another device creates it before the retry's PUT.
    srv.after(d => { Object.assign(d, OTHER()) })
    let during = null
    sheetAsk.mockImplementation(async () => { during = useStore.getState().sync.held; return false })
    await useStore.getState().syncNow()

    expect(srv.puts.map(p => p.baseRev)).toEqual([0, 0])   // the failed write, the retry's refused one: nothing merged
    expect(sheetAsk).toHaveBeenCalledTimes(1)
    expect(sheetAsk).toHaveBeenCalledWith(expect.objectContaining({ workouts: 1 }))
    expect(during).toBe(true)
    expect(ids(srv.doc.workouts)).toEqual(['o1'])
    expect(srv.doc.restSec).toBe(45)
    expect(ids(useStore.getState().S.workouts)).toEqual(['o1'])
    expect(useStore.getState().sync.held).toBe(false)
    expect(localStorage.getItem('gym_adopt')).toBeNull()
  })

  it('a write that fails on the network, with the profile there by the retry\'s read, asks once and writes nothing when declined', async () => {
    const srv = server(null)
    signIn()
    srv.failPuts = 1
    await useStore.getState().adoptProfile(vi.fn())
    srv.write(d => { Object.assign(d, OTHER()) })   // another device creates the profile meanwhile
    sheetAsk.mockResolvedValue(false)
    await useStore.getState().syncNow()

    expect(srv.puts.map(p => p.baseRev)).toEqual([0])
    expect(sheetAsk).toHaveBeenCalledTimes(1)
    expect(ids(srv.doc.workouts)).toEqual(['o1'])
    expect(srv.doc.restSec).toBe(45)
    expect(useStore.getState().sync.held).toBe(false)
  })

  it('a 409 after the question was asked and answered is an ordinary conflict: merged, not asked again', async () => {
    const srv = server(null)
    srv.after(d => { Object.assign(d, OTHER()) })
    signIn({ alwaysAsk: true })
    const ask = vi.fn(async () => true)
    expect(await useStore.getState().adoptProfile(ask, { alwaysAsk: true })).toEqual({ adopted: false, added: false })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(srv.puts.map(p => p.baseRev)).toEqual([0, 1])   // refused, merged, pushed
    expect(ids(srv.doc.workouts).sort()).toEqual(['g1', 'o1'])
  })
})

describe('AC5: the reset\'s notice', () => {
  it('is in every locale pack, and says something other than the import\'s', () => {
    const packs = import.meta.glob('../locales/*.js', { eager: true, import: 'default' })
    expect(Object.keys(packs).length).toBeGreaterThanOrEqual(19)
    for (const [file, pack] of Object.entries(packs)) {
      expect(pack[RESET_NOTICE], file).toBeTruthy()
      expect(pack[RESET_NOTICE], file).not.toBe(pack[IMPORT_NOTICE])
    }
  })
})

/* NATG-672: a copy with no stored base whose reset or import cannot read the server is not kept
   armed (NATG-655), so its next sync is a first sync, and that merge brings the server's entries
   back. The store says so once, at the failed read, in the replace's own words. */
describe('NATG-672: the notice when a replace with no base cannot read the server', () => {
  const RESET_OFFLINE = 'The server couldn’t be reached, so only this device was reset. Once you’re back online, what the server holds will be merged back in. Reset again then to clear it.'
  const IMPORT_OFFLINE = 'The server couldn’t be reached, so the backup replaced only this device’s copy. Once you’re back online, what the server holds will be merged in. Import again then to replace it.'
  const BACK_ONLINE = 'Back online and synced with the server.'
  const settled = () => vi.dynamicImportSettled()   // the store raises its toasts through a lazy import
  const notices = () => toasts().filter(m => m === RESET_OFFLINE || m === IMPORT_OFFLINE)
  const mine = () => { const S = PROFILE(); delete S._rev; delete S._wid; return S }
  const BACKUP = () => ({ ...clone(DEF), _ts: 40, workouts: [workout('wBackup', 30)] })
  const importOffline = async backup => {
    const token = useStore.getState().importToken()
    expect(await useStore.getState().importConflict(backup, token)).toBeNull()   // the check's read failed
    expect(useStore.getState().importBackup(backup, { token })).toBe(true)
    await useStore.getState().pushState()
  }

  it('AC1: a reset whose read fails on the network says only this device was reset, for 5 s, and nothing goes out', async () => {
    const srv = server(PROFILE())
    signedIn(mine())
    srv.failReads = 1
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await settled()

    expect(srv.puts).toEqual([])
    expect(toast.mock.calls.filter(([m]) => m === RESET_OFFLINE)).toEqual([[RESET_OFFLINE, { ms: 5000 }]])
    expect(notices()).toEqual([RESET_OFFLINE])
  })

  it('AC1: a server error on the read says the same', async () => {
    const srv = server(PROFILE())
    signedIn(mine())
    srv.failReads = 1
    srv.readError = () => Object.assign(new Error('server error'), { status: 500 })
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await settled()

    expect(srv.puts).toEqual([])
    expect(notices()).toEqual([RESET_OFFLINE])
  })

  it('AC2, AC6, AC7: NATG-655 finding 2. The import is merged with the server copy on reconnect, and the user was told once, at the failed read', async () => {
    const srv = server({ ...clone(DEF), _ts: 20, workouts: [workout('wServer', 20)], _rev: 1, _wid: 'wid-1' })
    signedIn({ ...clone(DEF), _ts: 10 })
    srv.failReads = 2   // the import check's read, then the push's
    await importOffline(BACKUP())
    await settled()

    expect(srv.calls).toEqual(['GET /api/data', 'GET /api/data'])
    expect(srv.puts).toEqual([])
    expect(toast.mock.calls.filter(([m]) => m === IMPORT_OFFLINE)).toEqual([[IMPORT_OFFLINE, { ms: 5000 }]])

    // Back online: the first-sync path merges, exactly as before this notice existed.
    await useStore.getState().pullState()
    await vi.waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].baseRev).toBe(1)
    expect(ids(srv.doc.workouts).sort()).toEqual(['wBackup', 'wServer'])
    await settled()
    // Shown once, and the reconnect says only what it always said.
    expect(notices()).toEqual([IMPORT_OFFLINE])
    expect(toasts().at(-1)).toBe(BACK_ONLINE)
  })

  it('AC7: pushes that fail again while still offline do not repeat it', async () => {
    const srv = server(PROFILE())
    signedIn(mine())
    srv.failReads = 3
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await useStore.getState().pushState()
    await useStore.getState().pushState()
    await settled()

    expect(srv.failReads).toBe(0)   // every one of them tried, and failed to read
    expect(notices()).toEqual([RESET_OFFLINE])
  })

  it('AC3: with a stored base, a reset whose read fails says nothing new', async () => {
    const srv = server(PROFILE())
    signedIn(mine(), 3, 'wid-3')
    srv.failReads = 1
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await settled()

    expect(srv.calls).toEqual(['GET /api/data'])
    expect(srv.puts).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('AC3: with a stored base, an import offline goes against that base, and says nothing new', async () => {
    const srv = server(PROFILE())
    signedIn(mine(), 3, 'wid-3')
    srv.failReads = 1
    srv.failPuts = 1
    await importOffline(BACKUP())
    await settled()

    expect(srv.calls).toEqual(['GET /api/data', 'PUT /api/data'])   // no read of its own: it has a base
    expect(srv.puts.map(p => p.baseRev)).toEqual([3])
    expect(toasts()).toEqual([])
  })

  it('AC4: when the read lands, no notice', async () => {
    const srv = server(PROFILE())
    signedIn(mine())
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    srv.failReads = 1   // the import's check fails, the push's own read lands
    await importOffline(BACKUP())
    await settled()

    expect(srv.puts.map(p => p.baseRev)).toEqual([3, 4])
    expect(notices()).toEqual([])
  })

  it('AC8: against a server from before revisions, a failed read says nothing', async () => {
    // Its answers carry no revision, and a PUT with none is taken as it is.
    const calls = []
    let failNextRead = false
    api.mockImplementation(async (path, o = {}) => {
      const method = o.method || 'GET'
      calls.push(method + ' ' + path)
      if (method === 'GET' && path === '/api/data') {
        if (failNextRead) { failNextRead = false; throw netErr() }
        return { state: PROFILE() }
      }
      if (method === 'PUT' && path === '/api/data') return { ok: true }
      return {}
    })
    signedIn(mine())
    useStore.getState().resetEverything()
    await useStore.getState().pushState()   // read answered with no revision: this server is revless
    expect(calls).toEqual(['GET /api/data', 'PUT /api/data'])

    failNextRead = true
    useStore.getState().resetEverything()
    await useStore.getState().pushState()
    await settled()

    expect(calls).toEqual(['GET /api/data', 'PUT /api/data', 'GET /api/data'])
    expect(toasts()).toEqual([])
  })

  it('AC5: both notices are in every locale pack, with the typographic apostrophe and no em dash', () => {
    for (const s of [RESET_OFFLINE, IMPORT_OFFLINE]) {
      expect(s).not.toMatch(/[—']/)
      expect(s).toMatch(/’/)
    }
    const packs = import.meta.glob('../locales/*.js', { eager: true, import: 'default' })
    expect(Object.keys(packs).length).toBeGreaterThanOrEqual(19)
    for (const [file, pack] of Object.entries(packs)) {
      for (const s of [RESET_OFFLINE, IMPORT_OFFLINE]) {
        expect(pack[s], file).toBeTruthy()
        expect(pack[s], file).not.toMatch(/—/)
      }
      expect(pack[RESET_OFFLINE], file).not.toBe(pack[IMPORT_OFFLINE])
    }
  })
})
