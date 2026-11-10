// @vitest-environment happy-dom
// NATG-500 (Tester's reproductions, reversed by the decision on the issue): a workout from a
// routine shared with you saves as a routine the way one of your own does. The copy is an
// ordinary routine of yours: a new id, no `shared:` link, the session's targets. The sharer's
// later edits and the end of the share leave it alone, and the shared routine itself is unchanged.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { freshStore } from './test-utils/fresh-store.js'
vi.mock('./lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
import { api } from './lib/api.js'
let DEF, useStore, useUI, sharedViewOf, buildCombinedEntries, saveSessionAsRoutine, workoutDetailSheet, setNav, isSharedId
const clone = v => structuredClone(v)
const ME = { id: 'qa-recipient', name: 'Recipient' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const accepted = (name = 'Original', hash = 'qa-h1', ex = [{ id: '0025', sets: 2, reps: 5, weight: 100 }], extra = {}) => ({ id: 'qa-share', state: 'accepted', from: { id: 'qa-sharer', name: 'Sharer' }, unit: 'kg', hash, routine: { id: 'source', name, ex, ...extra } })
const OWN = { id: 'r-own', name: 'Mine', ex: [{ id: '0007', sets: 1, reps: 8, weight: 20 }] }
let net
beforeEach(async () => {
  localStorage.clear()
  ;({ DEF, useStore } = await freshStore())
  ;({ useUI } = await import('./store/useUI.js'))
  ;({ sharedViewOf } = await import('./lib/shared-routines.js'))
  ;({ buildCombinedEntries } = await import('./lib/session-merge.js'))
  ;({ saveSessionAsRoutine } = await import('./lib/session-routines.js'))
  ;({ workoutDetailSheet } = await import('./sheets.jsx'))
  ;({ setNav } = await import('./lib/nav.js'))
  ;({ isSharedId } = await import('./lib/routine-lookup.js'))
  localStorage.setItem('gym_owner', ME.id)
  localStorage.setItem('gym_user', JSON.stringify(ME))
  const S = clone(DEF)
  S.routines = [clone(OWN)]
  S.week = { 1: ['shared:qa-share'], 2: ['shared:qa-share'], 3: ['shared:qa-share'], 4: ['shared:qa-share'], 5: ['shared:qa-share'], 6: ['shared:qa-share'], 0: ['shared:qa-share'] }
  net = { incoming: [accepted()], etag: 'qa-e1', rev: 1, state: clone(S), puts: [] }
  useStore.setState({ S, user: ME, ready: true, config: { shares: true, coach: null }, shares: null, sharesError: false, sync: { ...fresh } })
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: S._ts || 0, uid: ME.id }))
  api.mockReset()
  api.mockImplementation(async (path, o = {}) => {
    if (path === '/api/shares') return { incoming: clone(net.incoming), outgoing: [], etag: net.etag }
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path === '/api/data' && o.method === 'PUT') { const body = JSON.parse(o.body); net.puts.push(body); net.state = clone(body.state); return { ok: true, rev: ++net.rev } }
    if (path === '/api/data') return { state: clone(net.state), rev: net.rev }
    return {}
  })
})
afterEach(() => { useUI.setState({ sheets: [] }) })

// A finished workout trained from `ids`, every set done.
const workoutFrom = (ids, extra = {}) => {
  const st = useStore.getState()
  const built = buildCombinedEntries(st.S, ids, sharedViewOf(st))
  const w = { id: 'qa-workout', d: '2026-11-03', start: 1, end: 2, name: 'Original', prs: [], routineIds: built.routineIds, routineId: built.routineIds[0], entries: built.entries, ...extra }
  w.entries.forEach(e => e.sets.forEach(s => { s.done = true }))
  return w
}
// No `shared:` reference anywhere in it, and nothing that says it came from a share.
const independent = copy => {
  expect(isSharedId(copy.id)).toBe(false)
  expect(copy).not.toHaveProperty('shared')
  expect(JSON.stringify(copy)).not.toContain('shared')
  copy.ex.forEach(cfg => expect(cfg).not.toHaveProperty('rid'))
}

it('AC2: a shared workout saves as a routine of your own, with the session’s targets', async () => {
  await useStore.getState().loadShares()
  const w = workoutFrom(['shared:qa-share'])
  const draft = clone(useStore.getState().S)
  const id = saveSessionAsRoutine(draft, w, w.name, sharedViewOf(useStore.getState()))
  expect(draft.routines.map(r => r.id)).toEqual(['r-own', id])
  const copy = draft.routines.find(r => r.id === id)
  independent(copy)
  expect(copy).toMatchObject({ name: 'Original', ex: [{ id: '0025', sets: 2, reps: 5, weight: 100 }] })
})

it('AC1/AC2: a combined session, your routine and a shared one, saves both into one new routine', async () => {
  await useStore.getState().loadShares()
  const w = workoutFrom(['r-own', 'shared:qa-share'])
  expect(w.routineIds).toEqual(['r-own', 'shared:qa-share'])
  const draft = clone(useStore.getState().S)
  const id = saveSessionAsRoutine(draft, w, w.name, sharedViewOf(useStore.getState()))
  const copy = draft.routines.find(r => r.id === id)
  expect(copy.id).not.toBe('r-own')
  independent(copy)
  expect(copy.ex.map(cfg => [cfg.id, cfg.sets, cfg.reps, cfg.weight])).toEqual([['0007', 1, 8, 20], ['0025', 2, 5, 100]])
  // Your own routine is still yours, unchanged.
  expect(draft.routines.find(r => r.id === 'r-own')).toEqual(OWN)
})

it('AC1–AC3: WorkoutDetail saves a shared workout, and the copy outlives the sharer’s edits and the share', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const nav = vi.fn()
  setNav(nav)
  // The sharer's routine has a rule of its own: it has to come through the share, the shared view
  // and the sheet onto the copy, the way a copy of your own routine keeps its rule.
  const DOUBLE = accepted('Original', 'qa-h1', undefined, { prog: 'double' })
  net.incoming = [clone(DOUBLE)]
  await useStore.getState().loadShares()
  const w = workoutFrom(['shared:qa-share'], { id: 'qa-complete' })
  expect(w.sharedOrigin).toBeUndefined()
  useStore.setState({ S: { ...useStore.getState().S, workouts: [w] } })
  const sharedBefore = clone(sharedViewOf(useStore.getState()).byId.get('shared:qa-share'))
  const sharesBefore = clone(useStore.getState().shares)
  const mounted = []
  const renderTop = () => {
    const sheet = useUI.getState().sheets.at(-1)
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host); mounted.push([root, host])
    act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
    return host
  }
  const button = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label)
  try {
    act(() => workoutDetailSheet(w))
    const detail = renderTop()
    const save = button(detail, 'Save as routine')
    expect(save.disabled).toBe(false)
    expect(save.hasAttribute('aria-describedby')).toBe(false)
    expect(detail.textContent).not.toContain('routine shared with you')
    act(() => save.click())
    const confirm = renderTop()
    expect(confirm.textContent).toContain('Save as routine?')
    act(() => button(confirm, 'Save').click())
  } finally { mounted.forEach(([root, host]) => { act(() => root.unmount()); host.remove() }) }

  const S = useStore.getState().S
  expect(S.routines).toHaveLength(2)
  const copy = clone(S.routines.find(r => r.id !== 'r-own'))
  independent(copy)
  expect(copy).toMatchObject({ name: 'Original', ex: [{ id: '0025', sets: 2, reps: 5, weight: 100, prog: 'double' }] })
  expect(nav).toHaveBeenLastCalledWith('/plan/r/' + copy.id)
  // AC3: the shared routine as you see it, and the share itself, are as they were. The workout
  // that was copied still says where it came from.
  expect(sharedViewOf(useStore.getState()).byId.get('shared:qa-share')).toEqual(sharedBefore)
  expect(useStore.getState().shares).toEqual(sharesBefore)
  expect(net.incoming).toEqual([DOUBLE])
  expect(S.workouts[0].routineIds).toEqual(['shared:qa-share'])

  // The sharer edits their routine: the shared routine follows, your copy doesn't.
  net.incoming = [accepted('Renamed', 'qa-h2', [{ id: '0025', sets: 5, reps: 3, weight: 140 }])]; net.etag = 'qa-e2'
  await useStore.getState().loadShares()
  expect(sharedViewOf(useStore.getState()).byId.get('shared:qa-share')).toMatchObject({ name: 'Renamed', ex: [{ sets: 5, reps: 3 }] })
  expect(useStore.getState().S.routines.find(r => r.id === copy.id)).toEqual(copy)

  // The share ends: its pointers leave your plan, your copy stays.
  net.incoming = []; net.etag = 'qa-e3'
  await useStore.getState().loadShares()
  expect(useStore.getState().S.week[1]).toBeUndefined()
  expect(useStore.getState().S.routines.find(r => r.id === copy.id)).toEqual(copy)
})

it('still offers Save as routine for a workout from your own routine', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setNav(vi.fn())
  const w = { id: 'own', d: '2026-11-03', start: 1, end: 2, name: 'Mine', prs: [], routineIds: ['r1'], routineId: 'r1',
    entries: [{ id: '0025', rid: 'r1', sets: [{ w: 60, r: 5, done: true }] }] }
  useStore.setState({ S: { ...useStore.getState().S, workouts: [w] } })
  act(() => workoutDetailSheet(w))
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  try {
    const save = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save as routine')
    expect(save.disabled).toBe(false)
  } finally { act(() => root.unmount()); host.remove() }
})
