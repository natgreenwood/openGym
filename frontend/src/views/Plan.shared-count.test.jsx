// @vitest-environment happy-dom
// NATG-485: the routines list says how many people each routine is shared with ("Shared with 2"),
// from the sharer's own outgoing list, and says nothing of the kind while sharing is unavailable.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Plan from './Plan.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { S: null, config: null, user: null, shares: null, loads: 0 }
  state.snapshot = () => ({
    S: state.S, config: state.config, user: state.user, shares: state.shares,
    loadShares: () => { state.loads++; return Promise.resolve(state.shares) },
    update: mut => { const next = structuredClone(state.S); mut(next); state.S = next },
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => (selector ? selector(mocks.snapshot()) : mocks.snapshot())
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('../sheets.jsx', () => ({ starterPlanSheet: vi.fn(), dayAssignSheet: vi.fn() }))
vi.mock('../components/MiniBodyMap.jsx', () => ({ default: () => null }))

const ME = { id: 'u1', name: 'Sam' }
let host, root
beforeEach(() => {
  localStorage.setItem('gym_plan_view', 'routines')
  mocks.S = {
    unit: 'kg', workouts: [], exWeights: {}, week: {}, dayPlan: {},
    routines: [{ id: 'r1', name: 'Push', emoji: null, ex: [] }, { id: 'r2', name: 'Pull', emoji: null, ex: [] }],
  }
  mocks.loads = 0
  mocks.user = ME
  mocks.config = { shares: true }
  mocks.shares = {
    uid: 'u1', incoming: [], etag: 'e',
    outgoing: [{ id: 'a', to: { id: 'u2', name: 'Jo' }, routineId: 'r1' }, { id: 'b', to: { id: 'u3', name: 'Tom' }, routineId: 'r1' }],
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear() })

const subOf = name => [...host.querySelectorAll('.plan-routine')].find(r => r.querySelector('.tt')?.textContent === name)?.querySelector('.ss')?.textContent

describe('Plan — routines shared with others', () => {
  it('counts the people each routine is shared with', () => {
    act(() => root.render(<Plan />))
    expect(subOf('Push')).toBe('0 exercises · Shared with 2')
    expect(subOf('Pull')).toBe('0 exercises')
    expect(mocks.loads).toBeGreaterThan(0)
  })
  it('says nothing about sharing while it is off on the server, and asks the server nothing', () => {
    mocks.config = {}
    act(() => root.render(<Plan />))
    expect(subOf('Push')).toBe('0 exercises')
    expect(mocks.loads).toBe(0)
  })
  it('ignores a list loaded for another profile', () => {
    mocks.user = { id: 'u9', name: 'Other' }
    act(() => root.render(<Plan />))
    expect(subOf('Push')).toBe('0 exercises')
  })
})
