// @vitest-environment happy-dom
// NATG-500 (Tester's reproductions): a workout from a routine shared with you can't be saved as a
// routine of your own. The helper refuses, and the detail sheet's "Save as routine" is disabled
// with the reason. The DOM check was rewritten for the disabled button (the original clicked
// through to a confirm that no longer opens); its assertion, that no routine is created, stands.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('./lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
import { api } from './lib/api.js'
let DEF, useStore, useUI, sharedViewOf, buildCombinedEntries, saveSessionAsRoutine, workoutDetailSheet, setNav
const clone = v => structuredClone(v)
const ME = { id: 'qa-recipient', name: 'Recipient' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const accepted = (name = 'Original', hash = 'qa-h1') => ({ id: 'qa-share', state: 'accepted', from: { id: 'qa-sharer', name: 'Sharer' }, unit: 'kg', hash, routine: { id: 'source', name, ex: [{ id: '0025', sets: 2, reps: 5, weight: 100 }] } })
let net
beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  ;({ DEF, useStore } = await import('./store/useStore.js'))
  ;({ useUI } = await import('./store/useUI.js'))
  ;({ sharedViewOf } = await import('./lib/shared-routines.js'))
  ;({ buildCombinedEntries } = await import('./lib/session-merge.js'))
  ;({ saveSessionAsRoutine } = await import('./lib/session-routines.js'))
  ;({ workoutDetailSheet } = await import('./sheets.jsx'))
  ;({ setNav } = await import('./lib/nav.js'))
  localStorage.setItem('gym_owner', ME.id)
  localStorage.setItem('gym_user', JSON.stringify(ME))
  const S = clone(DEF)
  S.routines = []
  S.week = { 1: ['shared:qa-share'], 2: ['shared:qa-share'], 3: ['shared:qa-share'], 4: ['shared:qa-share'], 5: ['shared:qa-share'], 6: ['shared:qa-share'], 0: ['shared:qa-share'] }
  net = { incoming: [accepted()], etag: 'qa-e1', rev: 1, state: clone(S), puts: [] }
  useStore.setState({ S, user: ME, ready: true, config: { shares: true, coach: null }, shares: null, sharesError: false, sync: { ...fresh } })
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: S._ts || 0 }))
  api.mockReset()
  api.mockImplementation(async (path, o = {}) => {
    if (path === '/api/shares') return { incoming: clone(net.incoming), outgoing: [], etag: net.etag }
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path === '/api/data' && o.method === 'PUT') { const body = JSON.parse(o.body); net.puts.push(body); net.state = clone(body.state); return { ok: true, rev: ++net.rev } }
    if (path === '/api/data') return { state: clone(net.state), rev: net.rev }
    return {}
  })
})
afterEach(() => { useStore.setState({ ready: false, user: null }); useUI.setState({ sheets: [] }) })

it('AC5/parent AC14: a shared workout cannot become an editable routine', async () => {
  await useStore.getState().loadShares()
  const S = useStore.getState().S
  const built = buildCombinedEntries(S, ['shared:qa-share'], sharedViewOf(useStore.getState()))
  const w = { id: 'qa-workout', name: 'Original', routineIds: built.routineIds, routineId: built.routineIds[0], entries: built.entries }
  const draft = clone(S)
  const id = saveSessionAsRoutine(draft, w, w.name)
  console.log('COPIED_ROUTINE', JSON.stringify(draft.routines.find(r => r.id === id)))
  expect(draft.routines).toHaveLength(0)
})


it('AC5/parent AC14: WorkoutDetail offers no working Save as routine for a shared workout', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setNav(vi.fn())
  await useStore.getState().loadShares()
  const built = buildCombinedEntries(useStore.getState().S, ['shared:qa-share'], sharedViewOf(useStore.getState()))
  const w = { id: 'qa-complete', d: '2026-11-03', start: 1, end: 2, name: 'Original', prs: [], routineIds: built.routineIds, routineId: built.routineIds[0], entries: built.entries }
  w.entries.forEach(e => e.sets.forEach(s => { s.done = true }))
  useStore.setState({ S: { ...useStore.getState().S, workouts: [w] } })
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
    expect(save).toBeTruthy()
    expect(save.disabled).toBe(true)
    expect(detail.querySelector('#' + save.getAttribute('aria-describedby')).textContent)
      .toBe('This workout is from a routine shared with you, so it can’t be saved as a routine of your own.')
    const open = useUI.getState().sheets.length
    act(() => save.click())
    expect(useUI.getState().sheets).toHaveLength(open)
    expect(useStore.getState().S.routines).toHaveLength(0)
  } finally { mounted.forEach(([root, host]) => { act(() => root.unmount()); host.remove() }) }
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
    expect(host.querySelector('#save-routine-why')).toBeNull()
  } finally { act(() => root.unmount()); host.remove() }
})
