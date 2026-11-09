// @vitest-environment happy-dom
// NATG-501 (Tester's reproductions, brought in as they were): Sync now refreshes the share lists
// as well as the document, lists first, the order checkRev keeps.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { freshStore } from '../test-utils/fresh-store.js'
vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
import { api } from '../lib/api.js'
let DEF, useStore, useUI, sharedViewOf, buildCombinedEntries, saveSessionAsRoutine, workoutDetailSheet, setNav
const clone = v => structuredClone(v)
const ME = { id: 'qa-recipient', name: 'Recipient' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const accepted = (name = 'Original', hash = 'qa-h1') => ({ id: 'qa-share', state: 'accepted', from: { id: 'qa-sharer', name: 'Sharer' }, unit: 'kg', hash, routine: { id: 'source', name, ex: [{ id: '0025', sets: 2, reps: 5, weight: 100 }] } })
let net
beforeEach(async () => {
  localStorage.clear()
  ;({ DEF, useStore } = await freshStore())
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

it('AC3: Sync now refreshes an edited shared routine', async () => {
  await useStore.getState().loadShares()
  await useStore.getState().pullState()
  net.incoming = [accepted('Edited', 'qa-h2')]; net.etag = 'qa-e2'
  api.mockClear()
  await useStore.getState().syncNow()
  console.log('SYNC_NOW_CALLS', api.mock.calls.map(c => c[0]))
  expect(sharedViewOf(useStore.getState()).routines[0].name).toBe('Edited')
})

it.each(['revoked', 'custom-exercise'])('AC6/AC9: Sync now observes a share becoming %s', async state => {
  await useStore.getState().loadShares()
  await useStore.getState().pullState()
  net.incoming = state === 'revoked' ? [] : [{ id: 'qa-share', state: 'accepted', unavailable: state }]
  net.etag = 'qa-e2'
  await useStore.getState().syncNow()
  const view = sharedViewOf(useStore.getState())
  console.log('SYNC_NOW_AFTER_' + state, view.routines.map(r => r.name), JSON.stringify(useStore.getState().S.week))
  expect(view.routines).toHaveLength(0)
})
