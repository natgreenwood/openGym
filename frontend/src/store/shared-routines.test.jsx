// @vitest-environment happy-dom
// NATG-486: the store's side of the routines shared with you. The share lists are kept on this
// device (gym_shared_v1) and never in `S`; they load again when the revision poll says the
// `shares` etag moved; a share that has gone leaves the schedule through the same delete as your
// own routines, while one that is only not available keeps its days; removing one asks the server
// and takes it off your plan; a sign-out wipes the lists.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ui = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: ui.toast, stopRest: vi.fn(), abandonWork: vi.fn(), closeAll: vi.fn(), dismissToast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF, SHARED_KEY, useStore } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const USER = { id: 'u2', name: 'Jo' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
const LEG = { id: 'r9', name: 'Leg Day', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }] }
const accepted = (id, extra = {}) => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h' + id, routine: LEG, ...extra })

let net
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('gym_owner', USER.id); api.mockReset(); ui.toast.mockReset()
  net = { incoming: [accepted('s1')], etag: 'e1', rev: 1, puts: [] }
  useStore.setState({ S: clone(DEF), user: null, ready: false, sync: { ...fresh }, config: null, shares: null, sharesError: false })
  api.mockImplementation(async (path, o = {}) => {
    const method = o.method || 'GET'
    if (path === '/api/shares') return { incoming: clone(net.incoming), outgoing: [], etag: net.etag }
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path.startsWith('/api/shares/') && method === 'DELETE') { net.incoming = net.incoming.filter(i => !path.endsWith(i.id)); return { ok: true } }
    if (path === '/api/data' && method === 'PUT') { net.puts.push(JSON.parse(o.body)); return { ok: true, rev: ++net.rev } }
    if (path === '/api/data') return { state: clone(useStore.getState().S), rev: net.rev }
    return {}
  })
})
const signedIn = (S = clone(DEF)) => {
  useStore.setState({ S, user: USER, ready: true, sync: { ...fresh }, config: { shares: true } })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: net.rev, ts: S._ts || 0 }))
}

describe('the share lists live on this device, never in S', () => {
  it('keeps the last answer under gym_shared_v1, with when it came', async () => {
    signedIn()
    await useStore.getState().loadShares()
    const saved = JSON.parse(localStorage.getItem(SHARED_KEY))
    expect(saved).toMatchObject({ uid: 'u2', etag: 'e1', incoming: [{ id: 's1' }] })
    expect(saved.fetchedAt).toBeGreaterThan(0)
    const S = useStore.getState().S
    expect(JSON.stringify(S)).not.toContain('Leg Day')
    expect(S.shares).toBeUndefined()
  })

  it('never pushes a shared routine: scheduling one writes only its pointer', async () => {
    signedIn()
    await useStore.getState().loadShares()
    useStore.getState().update(s => { s.week[1] = ['shared:s1'] })
    await useStore.getState().pushState()
    const pushed = net.puts.at(-1).state
    expect(pushed.week[1]).toEqual(['shared:s1'])
    expect(JSON.stringify(pushed)).not.toContain('Leg Day')
    expect(pushed.routines.some(r => String(r.id).startsWith('shared:'))).toBe(false)
  })

  it('a new start reads them back for the same account only (offline at the last-synced version, AC8)', async () => {
    localStorage.setItem('gym_user', JSON.stringify(USER))
    localStorage.setItem(SHARED_KEY, JSON.stringify({ uid: 'u2', incoming: [accepted('s1')], outgoing: [], etag: 'e1', fetchedAt: 5 }))
    vi.resetModules()
    let { useStore: again } = await import('./useStore.js')
    expect(again.getState().shares).toMatchObject({ uid: 'u2', fetchedAt: 5 })
    localStorage.setItem('gym_user', JSON.stringify({ id: 'u7', name: 'Someone else' }))
    vi.resetModules()
    ;({ useStore: again } = await import('./useStore.js'))
    expect(again.getState().shares).toBeNull()
  })
})

describe('a sharer’s edit shows after the next sync (AC3)', () => {
  it('loads the lists again when the revision poll’s `shares` etag moved, and only then', async () => {
    signedIn()
    await useStore.getState().loadShares()
    const loads = () => api.mock.calls.filter(([p]) => p === '/api/shares').length
    const before = loads()
    window.dispatchEvent(new Event('online'))
    await tick()
    expect(loads()).toBe(before)
    net.etag = 'e2'
    net.incoming = [accepted('s1', { hash: 'h-edited', routine: { ...LEG, name: 'Leg Day v2' } })]
    window.dispatchEvent(new Event('online'))
    await tick()
    expect(loads()).toBe(before + 1)
    expect(useStore.getState().shares.incoming[0].routine.name).toBe('Leg Day v2')
  })
})

describe('a share that has gone leaves the schedule (AC6), one not available keeps it (AC9)', () => {
  it('removes the pointers of a revoked share from every day, and says so once', async () => {
    signedIn({ ...clone(DEF), week: { 1: ['shared:s1'], 3: ['r1', 'shared:s1'] }, dayPlan: { '2026-11-20': 'shared:s1' } })
    await useStore.getState().loadShares()
    expect(ui.toast).not.toHaveBeenCalled()
    net.incoming = []
    await useStore.getState().loadShares()
    await tick()
    const S = useStore.getState().S
    expect(S.week[1]).toBeUndefined()
    expect(S.week[3]).toEqual(['r1'])
    expect(S.dayPlan['2026-11-20']).toBeUndefined()
    expect(ui.toast).toHaveBeenCalledTimes(1)
    expect(ui.toast.mock.calls[0][0]).toBe('Leg Day is no longer shared with you. It’s off your schedule too.')
  })

  it('keeps the days of a share that is not available right now, so it comes back when it heals', async () => {
    signedIn({ ...clone(DEF), week: { 6: ['shared:s1'] } })
    await useStore.getState().loadShares()
    net.incoming = [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unavailable: 'custom-exercise' }]
    await useStore.getState().loadShares()
    expect(useStore.getState().S.week[6]).toEqual(['shared:s1'])
    expect(useStore.getState().shares.names.s1).toBe('Leg Day')
    expect(ui.toast).not.toHaveBeenCalled()
  })

  it('judges no pointer by a list that is only kept on this device', async () => {
    // A page that has not heard from the server yet: only the kept list, which can be older
    // than a share accepted on another device.
    vi.resetModules()
    const { useStore: page } = await import('./useStore.js')
    page.setState({ S: { ...clone(DEF), week: { 1: ['shared:s1'] } }, user: USER, ready: true, shares: { uid: 'u2', incoming: [], outgoing: [], etag: 'old' } })
    page.getState().sweepSharedPointers()
    expect(page.getState().S.week[1]).toEqual(['shared:s1'])
  })

  it('judges nothing by the answer sharing gives while it is off', async () => {
    signedIn({ ...clone(DEF), week: { 1: ['shared:s1'] } })
    net.incoming = []; net.etag = 'off'
    await useStore.getState().loadShares()
    expect(useStore.getState().S.week[1]).toEqual(['shared:s1'])
  })
})

describe('removing a shared routine (AC6)', () => {
  it('asks the server, takes it off every day, and leaves the lists without it', async () => {
    signedIn({ ...clone(DEF), week: { 2: ['shared:s1'] } })
    await useStore.getState().loadShares()
    await useStore.getState().removeShare('s1')
    expect(api).toHaveBeenCalledWith('/api/shares/s1', { method: 'DELETE' })
    expect(useStore.getState().S.week[2]).toBeUndefined()
    expect(useStore.getState().shares.incoming).toEqual([])
    // Your own removal is no news: no "no longer shared" toast.
    await tick()
    expect(ui.toast).not.toHaveBeenCalled()
  })

  it('changes nothing when the server can’t be reached, and says why to the caller', async () => {
    signedIn({ ...clone(DEF), week: { 2: ['shared:s1'] } })
    await useStore.getState().loadShares()
    const real = api.getMockImplementation()
    api.mockImplementation(async (path, o = {}) => {
      if (o.method === 'DELETE') throw Object.assign(new Error('offline'), { status: 0 })
      return real(path, o)
    })
    await expect(useStore.getState().removeShare('s1')).rejects.toThrow()
    expect(useStore.getState().S.week[2]).toEqual(['shared:s1'])
  })
})

describe('signing out', () => {
  it('wipes the kept lists', async () => {
    signedIn()
    await useStore.getState().loadShares()
    await useStore.getState().signOut({ force: true })
    expect(localStorage.getItem(SHARED_KEY)).toBeNull()
    expect(useStore.getState().shares).toBeNull()
  })
})
