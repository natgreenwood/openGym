// @vitest-environment happy-dom
// NATG-524: a Remove whose DELETE settles after the account that asked signed out and another
// signed in says nothing about it to the new account: no toast naming the routine, on success
// (AC1) or failure (AC2), and no move to Plan. Without a switch it behaves as before (AC3). The
// sign-out is the store's own (signOut), so it is the real session cleanup.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('../sheets.jsx', () => ({ exConfigSheet: vi.fn(), exercisePicker: vi.fn(), glyphPicker: vi.fn(), confirmSheet: vi.fn(), exerciseDetailSheet: vi.fn() }))
vi.mock('../components/Media.jsx', () => ({ Thumb: () => null }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null }))

import RoutineEdit from './RoutineEdit.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { confirmSheet } from '../sheets.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const A = { id: 'u2', name: 'Jo Patel' }
const B = { id: 'u3', name: 'Ana Silva' }
const LEG = { id: 'r9', name: 'Leg Day', emoji: 'barbell', prog: 'double', ex: [{ id: '0025', sets: 5, mode: 'reps', reps: 5, weight: 100 }] }
const SHARE = { id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unit: 'kg', hash: 'h1', routine: LEG }
let root, host, moves, toasts, unsubToast, held

// Every navigation, from the first render on: a move the Remove makes shows up as one more entry.
const Moves = () => { const loc = useLocation(); moves.push(loc.key); return null }

async function mount() {
  const S = JSON.parse(JSON.stringify(DEF))
  S.week = { 6: ['shared:s1'] }
  S.routines = [{ id: 'r1', name: 'Push', ex: [] }]
  localStorage.setItem('gym_owner', A.id)
  useStore.setState({ S, user: A, config: { shares: true }, ready: true, shares: { uid: A.id, incoming: [SHARE], outgoing: [], etag: 'e', fetchedAt: 1 } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<MemoryRouter initialEntries={['/plan/r/' + encodeURIComponent('shared:s1')]}>
    <Moves />
    <Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /><Route path="/plan" element={null} /></Routes>
  </MemoryRouter>))
  await act(() => new Promise(r => setTimeout(r, 0)))
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const removeButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Remove from my plan')
// Confirms Remove; the DELETE waits until `held` is resolved or rejected.
async function confirmRemove() {
  act(() => removeButton().click())
  const dialog = vi.mocked(confirmSheet).mock.calls[0][0]
  let done
  await act(async () => { done = dialog.onConfirm(); await Promise.resolve() })
  expect(api).toHaveBeenCalledWith('/api/shares/s1', { method: 'DELETE' })
  return () => act(() => done)
}
// A signs out the way Settings does, then B signs in on the same device.
async function switchAccount() {
  let out
  await act(async () => { out = await useStore.getState().signOut() })
  expect(out).toEqual({ owed: false })
  expect(useStore.getState().user).toBeNull()
  act(() => useStore.getState().setUser(B))
  expect(useStore.getState().user?.id).toBe(B.id)
}
const named = () => toasts.filter(m => m.includes('Leg Day'))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '' })
  moves = []
  toasts = []
  unsubToast = useUI.subscribe(s => { if (s.toastMsg) toasts.push(s.toastMsg) })
  // The server: A has the share until its DELETE lands, B has none. The lists answer for
  // whoever is signed in when they are asked for.
  const incoming = { [A.id]: [SHARE], [B.id]: [] }
  let release, fail
  held = { resolve: () => release(), reject: e => fail(e) }
  const pending = new Promise((res, rej) => { release = res; fail = rej })
    .then(() => { incoming[A.id] = []; return { ok: true } })
  vi.mocked(api).mockImplementation(async (path, opts = {}) => {
    if (path === '/api/shares/s1' && opts.method === 'DELETE') return pending
    if (path === '/api/shares') return { incoming: incoming[useStore.getState().user?.id] || [], outgoing: [], etag: 'e' + Math.random() }
    return { ok: true }
  })
})
afterEach(() => { unsubToast(); act(() => root.unmount()); host.remove() })

describe('Remove settling after an account switch', () => {
  it('shows no toast and does not navigate when the DELETE succeeds (AC1)', async () => {
    await mount()
    const finish = await confirmRemove()
    await switchAccount()
    await settle()
    const before = moves.length
    held.resolve()
    await finish()
    await settle()
    expect(named()).toEqual([])
    expect(moves.length).toBe(before)
  })

  it('shows no failure toast when the DELETE fails (AC2)', async () => {
    await mount()
    const finish = await confirmRemove()
    await switchAccount()
    await settle()
    const before = moves.length
    held.reject(Object.assign(new Error('offline'), { code: 'network' }))
    await finish()
    await settle()
    expect(named()).toEqual([])
    expect(moves.length).toBe(before)
  })
})

describe('Remove without an account switch (AC3)', () => {
  it('says it is off your plan and goes back to Plan when the DELETE succeeds', async () => {
    await mount()
    const finish = await confirmRemove()
    const before = moves.length
    held.resolve()
    await finish()
    await settle()
    expect(named()).toEqual(['Leg Day is off your plan.'])
    expect(moves.length).toBe(before + 1)
  })

  it('says it could not remove it, stays put and offers Remove again when the DELETE fails', async () => {
    await mount()
    const finish = await confirmRemove()
    expect(removeButton().disabled).toBe(true)
    const before = moves.length
    held.reject(Object.assign(new Error('offline'), { code: 'network' }))
    await finish()
    await settle()
    expect(named()).toEqual(['Couldn’t remove Leg Day. Check your connection and try again.'])
    expect(moves.length).toBe(before)
    expect(removeButton().disabled).toBe(false)
  })
})
