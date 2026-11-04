// @vitest-environment happy-dom
// SEC-486-02: a workout from a routine shared with you keeps saying so, however it is reached.
// "Repeat today" builds a session with no routine ids at all, so the shared origin is said on the
// session itself (`sharedOrigin`), carried into the saved workout, into a repeat and a repeat of
// that, through a push to the server, and kept after the share has ended. Save as routine works
// on each of them as it does on your own (NATG-500). The whole sequence, with the real store,
// session builders and detail sheet.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('./lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
import { api } from './lib/api.js'
let DEF, useStore, useUI, sheets, saveSessionAsRoutine, setNav
const clone = v => structuredClone(v)
const ME = { id: 'u2', name: 'Jo' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const accepted = { id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h1', routine: { id: 'r9', name: 'Leg Day', ex: [{ id: '0025', sets: 2, reps: 5, weight: 100 }] } }
let net
beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  ;({ DEF, useStore } = await import('./store/useStore.js'))
  ;({ useUI } = await import('./store/useUI.js'))
  sheets = await import('./sheets.jsx')
  ;({ saveSessionAsRoutine } = await import('./lib/session-routines.js'))
  ;({ setNav } = await import('./lib/nav.js'))
  setNav(vi.fn())
  localStorage.setItem('gym_owner', ME.id)
  localStorage.setItem('gym_user', JSON.stringify(ME))
  const S = clone(DEF)
  S.routines = [{ id: 'r1', name: 'Push', ex: [{ id: '0007', sets: 1, reps: 8 }] }]
  S.week = { 1: ['shared:s1'] }
  S.weighIn = false
  net = { incoming: [clone(accepted)], etag: 'e1', rev: 1, puts: [] }
  useStore.setState({ S, user: ME, ready: true, config: { shares: true }, shares: null, sharesError: false, sync: { ...fresh } })
  useUI.setState({ sheets: [] })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: S._ts || 0 }))
  api.mockReset()
  api.mockImplementation(async (path, o = {}) => {
    if (path === '/api/shares') return { incoming: clone(net.incoming), outgoing: [], etag: net.etag }
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path === '/api/data' && o.method === 'PUT') { net.puts.push(JSON.parse(o.body)); return { ok: true, rev: ++net.rev } }
    if (path === '/api/data') return { state: clone(useStore.getState().S), rev: net.rev }
    return {}
  })
})
afterEach(() => { useStore.setState({ ready: false, user: null }); useUI.setState({ sheets: [] }) })

// Every set done, then Finish: the saved workout is the newest one.
const trainAndFinish = () => {
  useStore.getState().update(s => { s.active.entries.forEach(e => e.sets.forEach(x => { x.done = true })) })
  sheets.finishWorkoutNow()
  useUI.setState({ sheets: [] })
  return useStore.getState().S.workouts.at(-1)
}
const saveButtonFor = w => {
  act(() => sheets.workoutDetailSheet(w))
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  const save = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save as routine')
  return { save, host, done: () => { act(() => root.unmount()); host.remove() } }
}

it('a shared workout, repeated twice after the share ended, keeps its origin and saves as a routine', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await useStore.getState().loadShares()
  sheets.beginWorkout(['shared:s1'], null)
  expect(useStore.getState().S.active.sharedOrigin).toBe(true)
  const first = trainAndFinish()
  expect(first.routineIds).toEqual(['shared:s1'])
  expect(first.sharedOrigin).toBe(true)

  // The share ends: the pointers leave the plan, the workout stays as it was logged.
  net.incoming = []; net.etag = 'e2'
  await useStore.getState().loadShares()
  expect(useStore.getState().S.week[1]).toBeUndefined()

  // Repeat today: no routine ids at all, the origin carried over.
  sheets.repeatWorkout(first)
  expect(useStore.getState().S.active.routineIds).toEqual([])
  expect(useStore.getState().S.active.sharedOrigin).toBe(true)
  const second = trainAndFinish()
  expect(second.routineIds).toEqual([])
  expect(second.entries.every(e => !e.rid)).toBe(true)
  expect(second.sharedOrigin).toBe(true)

  // And a repeat of the repeat.
  sheets.repeatWorkout(second)
  const third = trainAndFinish()
  expect(third.sharedOrigin).toBe(true)

  // It goes to the server with the workouts.
  await useStore.getState().pushState()
  expect(net.puts.at(-1).state.workouts.map(w => w.sharedOrigin)).toEqual([true, true, true])

  // Save as routine (NATG-500): the helper makes a routine of your own from it, and the sheet's
  // button is the enabled one your own workouts have.
  const draft = clone(useStore.getState().S)
  const id = saveSessionAsRoutine(draft, third, third.name)
  expect(draft.routines.map(r => r.id)).toEqual(['r1', id])
  expect(id.startsWith('shared:')).toBe(false)
  expect(draft.routines[1].ex.map(cfg => [cfg.id, cfg.sets, cfg.reps, cfg.weight])).toEqual([['0025', 2, 5, 100]])
  const { save, done } = saveButtonFor(third)
  try { expect(save.disabled).toBe(false) } finally { done() }
})

it('a workout from your own routine, and a repeat of it, still save as a routine', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  sheets.beginWorkout(['r1'], null)
  const own = trainAndFinish()
  expect(own.sharedOrigin).toBeUndefined()
  sheets.repeatWorkout(own)
  const again = trainAndFinish()
  expect(again.sharedOrigin).toBeUndefined()
  const { save, done } = saveButtonFor(again)
  try { expect(save.disabled).toBe(false) } finally { done() }
})

it('adding a shared routine to a session of your own marks the whole session', async () => {
  await useStore.getState().loadShares()
  sheets.beginWorkout(['r1'], null)
  expect(useStore.getState().S.active.sharedOrigin).toBeUndefined()
  sheets.addRoutineToSessionSheet()
  // The sheet's own add, as a tap on the shared row runs it.
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  try {
    const row = [...host.querySelectorAll('.item')].find(r => r.querySelector('.tt')?.textContent === 'Leg Day')
    act(() => row.click())
    expect(useStore.getState().S.active.sharedOrigin).toBe(true)
  } finally { act(() => root.unmount()); host.remove() }
})

it('editing a saved shared workout keeps its origin', async () => {
  const { editCompletedSession, saveWorkoutEdit } = await import('./lib/session-edit.js')
  await useStore.getState().loadShares()
  sheets.beginWorkout(['shared:s1'], null)
  const w = trainAndFinish()
  const draft = clone(useStore.getState().S)
  editCompletedSession(draft, w)
  draft.active.note = 'felt strong'
  saveWorkoutEdit(draft)
  expect(draft.active).toBeNull()
  const saved = draft.workouts.find(x => x.id === w.id)
  expect(saved.note).toBe('felt strong')
  expect(saved.sharedOrigin).toBe(true)
})
