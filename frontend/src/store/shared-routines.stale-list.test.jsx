// @vitest-environment happy-dom
// NATG-499 (Tester's reproduction, brought in as it was): a revision poll saw a newer `shares`
// etag while an older list request was in flight, and a document pull brought new pointers in the
// meantime. The older answer must not sweep them: it is stale (a newer etag was seen after it
// left), and those pointers arrived after it left.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
import { api } from '../lib/api.js'
let DEF, useStore, useUI, sharedViewOf, buildCombinedEntries, saveSessionAsRoutine, workoutDetailSheet, setNav
const clone = v => structuredClone(v)
const ME = { id: 'qa-recipient', name: 'Recipient' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const accepted = (name = 'Original', hash = 'qa-h1') => ({ id: 'qa-share', state: 'accepted', from: { id: 'qa-sharer', name: 'Sharer' }, unit: 'kg', hash, routine: { id: 'source', name, ex: [{ id: '0025', sets: 2, reps: 5, weight: 100 }] } })
let net
beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  ;({ DEF, useStore } = await import('../store/useStore.js'))
  ;({ useUI } = await import('../store/useUI.js'))
  ;({ sharedViewOf } = await import('../lib/shared-routines.js'))
  ;({ buildCombinedEntries } = await import('../lib/session-merge.js'))
  ;({ saveSessionAsRoutine } = await import('../lib/session-routines.js'))
  ;({ workoutDetailSheet } = await import('../sheets.jsx'))
  ;({ setNav } = await import('../lib/nav.js'))
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

it('AC4: an older share list must not erase pointers pulled while it was in flight', async () => {
  useStore.setState({ S: { ...useStore.getState().S, week: {} } })
  net.state = clone(useStore.getState().S)
  net.incoming = []
  await useStore.getState().pullState()
  const real = api.getMockImplementation()
  let answer
  api.mockImplementation((path, opts) => path === '/api/shares' ? new Promise(resolve => { answer = resolve }) : real(path, opts))
  const older = useStore.getState().loadShares()
  // Another device accepts and schedules the newly received share after this response's snapshot.
  net.incoming = [accepted()]; net.etag = 'qa-e2'; net.rev = 2
  net.state.week = { 0: ['shared:qa-share'], 1: ['shared:qa-share'], 2: ['shared:qa-share'], 3: ['shared:qa-share'], 4: ['shared:qa-share'], 5: ['shared:qa-share'], 6: ['shared:qa-share'] }
  // Revision polling notices e2, but loadShares coalesces onto the older e1 request.
  window.dispatchEvent(new Event('online'))
  await new Promise(resolve => setTimeout(resolve, 5))
  await useStore.getState().pullState()
  expect(useStore.getState().S.week[1]).toEqual(['shared:qa-share'])
  answer({ incoming: [], outgoing: [], etag: 'qa-e1' })
  await older
  console.log('RACE_WEEK', JSON.stringify(useStore.getState().S.week))
  await useStore.getState().pushState()
  console.log('RACE_PUSH_WEEK', JSON.stringify(net.puts.at(-1)?.state.week))
  console.log('RACE_SHARE_GETS', api.mock.calls.filter(c => c[0] === '/api/shares').length)
  expect(useStore.getState().S.week[1]).toEqual(['shared:qa-share'])
})

// The ordering rule's second half, on its own: no newer etag is seen, but a pull lands while the
// list request is out. The answer may only sweep the pointers the document held when it left; a
// pointer that arrived later is kept, and the lists load again so a newer answer can judge it.
it('NATG-499: a pointer pulled after the list request left is kept, and judged by the next load', async () => {
  useStore.setState({ S: { ...useStore.getState().S, week: {} } })
  net.state = clone(useStore.getState().S)
  net.incoming = []
  await useStore.getState().pullState()
  const real = api.getMockImplementation()
  const answers = []
  api.mockImplementation((path, opts) => path === '/api/shares' ? new Promise(resolve => { answers.push(resolve) }) : real(path, opts))
  const first = useStore.getState().loadShares()
  net.rev = 2
  net.state.week = { 2: ['shared:qa-share'] }
  await useStore.getState().pullState()
  answers[0]({ incoming: [], outgoing: [], etag: 'qa-e1' })
  await first
  expect(useStore.getState().S.week[2]).toEqual(['shared:qa-share'])
  // The next load left with the pointer in the document: its answer judges it.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(answers).toHaveLength(2)
  answers[1]({ incoming: [], outgoing: [], etag: 'qa-e1' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(useStore.getState().S.week[2]).toBeUndefined()
})
