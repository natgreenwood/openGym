// @vitest-environment happy-dom
// NATG-486: a plan made only of routines shared with you is a plan. Home's welcome card ("Set up
// your weekly routine") is for an empty plan, not for one whose routines all come from others.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import Home from './Home.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(),
}))

const ME = { id: 'u2', name: 'Jo' }
const LEG = { id: 'r9', name: 'Leg Day', ex: [{ id: '0025', sets: 3, reps: 5 }] }
let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const setUp = incoming => useStore.setState(s => ({
  S: { ...s.S, routines: [], week: { 1: ['shared:s1'] }, dayPlan: {}, workouts: [], active: null },
  user: ME,
  shares: { uid: 'u2', incoming, outgoing: [], etag: 'e' },
}))
const welcome = () => host.textContent.includes('Set up your weekly routine')

describe('Home welcome card with routines shared with you', () => {
  it('is not shown when the plan holds a shared routine', () => {
    setUp([{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h', routine: LEG }])
    act(() => root.render(<Home />))
    expect(welcome()).toBe(false)
  })
  it('is shown when nothing is planned and nothing is shared', () => {
    setUp([])
    act(() => root.render(<Home />))
    expect(welcome()).toBe(true)
  })
})

// NATG-498: the streak card counts a weekday planned with a shared routine as planned.
describe('Home streak card with routines shared with you', () => {
  const tally = () => host.textContent.match(/(\d+)( \/ (\d+))? this week/)?.[0]
  it('counts the shared day in the week’s plan', () => {
    setUp([{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h', routine: LEG }])
    act(() => root.render(<Home />))
    expect(tally()).toBe('0 / 1 this week')
  })
  it('leaves it out once the share has ended, as a rest day', () => {
    setUp([])
    act(() => root.render(<Home />))
    expect(tally()).toBe('0 this week')
  })
})
