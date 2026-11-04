// @vitest-environment happy-dom
// Weekly muscle volume, as planned: it lived on Plan until v1.3.11 and is analysis, so it moved to
// Stats, right after Muscle balance (Plan keeps a row that links here, /stats?focus=weekly-volume).
// What it counts did not change: every weekday routine once, plus a running rotation's sessions.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ S: null, user: null, shares: null }))
vi.mock('../store/useStore.js', () => ({ useStore: selector => selector({ S: mocks.S, user: mocks.user, shares: mocks.shares }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../sheets.jsx', () => ({
  bwSheet: vi.fn(), goalSheet: vi.fn(), calendarSheet: vi.fn(), workoutDetailSheet: vi.fn(),
  exerciseHistorySheet: vi.fn(), WorkoutRow: () => React.createElement('div'), bwDeltaColor: () => '', weighInsSheet: vi.fn(),
}))
vi.mock('../components/Heatmap.jsx', () => ({ default: () => React.createElement('div') }))
vi.mock('../components/LineChart.jsx', () => ({ default: () => React.createElement('div') }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => React.createElement('div'), BodyMapLegend: () => null }))

import Stats, { WeeklyPlanVolume } from './Stats.jsx'

const press = { id: 'press', n: 'Press', primaries: ['chest'], secondaries: ['triceps'], custom: true }
const state = over => ({
  unit: 'kg', body: 'male', effort: null, targetW: null, bodyweight: [], exWeights: {}, workouts: [], dayPlan: {},
  routines: [{ id: 'push', name: 'Push', emoji: null, ex: [{ id: press.id, sets: 2 }] }],
  customEx: [press], week: { 1: ['push'] }, weekStart: 1, queue: null, rotation: null, ...over,
})

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); window.location.hash = '' })

const card = () => host.querySelector('[data-weekly-muscle-volume]')
const render = S => act(() => root.render(<WeeklyPlanVolume S={S} />))

describe('Stats — weekly muscle volume from the plan', () => {
  it('shows every non-zero effective-set total from the recurring schedule', () => {
    render(state())
    expect(card().textContent).toContain('Weekly muscle volume')
    expect(card().textContent).toContain('Chest2 sets')
    expect(card().textContent).toContain('Triceps0.8 sets')
  })

  it('follows the weekly schedule: a routine on two days counts twice', () => {
    render(state({ week: { 1: ['push'], 3: 'push' } }))
    expect(card().textContent).toContain('Chest4 sets')
    expect(card().textContent).toContain('Triceps1.6 sets')
  })

  it('counts the sessions of a running rotation too', () => {
    render(state({ week: {}, queue: { ids: ['push'], since: Date.now(), startsOn: '2026-01-01', label: 'R' } }))
    expect(card().textContent).toContain('Chest2 sets')
  })

  it('says so when the plan has no volume', () => {
    render(state({ week: { 1: ['stale'] } }))
    expect(card().textContent).toContain('No muscle volume planned.')
    expect(card().querySelector('.mrow')).toBeNull()
  })

  it('omits explicit zero-weight muscles', () => {
    const zeroPress = { id: 'zero-press', n: 'Zero press', muscleWeights: { chest: 1, biceps: 0 }, custom: true }
    render(state({ customEx: [zeroPress], routines: [{ id: 'z', name: 'Zero', ex: [{ id: zeroPress.id, sets: 2 }] }], week: { 1: ['z'] } }))
    expect(card().textContent).toContain('Chest2 sets')
    expect(card().textContent).not.toContain('Biceps')
  })

  it('shows the top five and opens the rest on Show more', () => {
    const many = { id: 'many', n: 'Many', primaries: ['chest', 'lats', 'quads', 'glutes', 'hamstrings', 'calves'], secondaries: [], custom: true }
    render(state({ customEx: [many], routines: [{ id: 'm', name: 'M', ex: [{ id: many.id, sets: 3 }] }], week: { 1: ['m'] } }))
    expect(card().querySelectorAll('.mrow').length).toBe(5)
    const more = card().querySelector('.weekly-plan-toggle')
    expect(more.textContent).toBe('Show more')
    act(() => more.click())
    expect(card().querySelectorAll('.mrow').length).toBe(6)
    expect(card().querySelector('.weekly-plan-toggle').textContent).toBe('Show less')
  })

  it('sits on Stats right after Muscle balance, and only once there are routines', () => {
    mocks.S = state()
    act(() => root.render(<Stats />))
    const balance = [...host.querySelectorAll('.card h2')].find(h => h.textContent.startsWith('Muscle balance'))?.closest('.card')
    expect(balance).toBeTruthy()
    expect(balance.nextElementSibling).toBe(card())
    expect(card().id).toBe('weekly-volume')
    mocks.S = state({ routines: [], week: {} })
    act(() => root.render(<Stats />))
    expect(card()).toBeNull()
  })

  it('shows for a plan made only of routines shared with you, with their planned sets (NATG-498)', () => {
    mocks.user = { id: 'u2', name: 'Jo' }
    mocks.shares = { uid: 'u2', etag: 'e', outgoing: [], incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h',
      routine: { id: 'r9', name: 'Leg Day', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }] } }] }
    try {
      mocks.S = state({ routines: [], customEx: [], week: { 1: ['shared:s1'] } })
      act(() => root.render(<Stats />))
      expect(card()).toBeTruthy()
      expect(card().querySelectorAll('.mrow').length).toBeGreaterThan(0)
      expect(card().textContent).not.toContain('No muscle volume planned.')
      // the same plan without the shared routines is no plan at all, as before
      mocks.shares = null
      act(() => root.render(<Stats />))
      expect(card()).toBeNull()
    } finally { mocks.user = null; mocks.shares = null }
  })

  it('scrolls itself into view when Plan links here', () => {
    vi.useFakeTimers()
    try {
      window.location.hash = '#/stats?focus=weekly-volume'
      mocks.S = state()
      const scroll = vi.fn()
      const orig = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = scroll
      act(() => root.render(<Stats />))
      act(() => { vi.advanceTimersByTime(50) })
      Element.prototype.scrollIntoView = orig
      expect(scroll).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  // NATG-527: a plan made only of shared routines shows the card once the shares load, which can
  // be after the first frame. The deep link still scrolls to it, exactly once.
  describe('the deep link with a plan made only of shared routines', () => {
    const shareLists = () => ({ uid: 'u2', etag: 'e', outgoing: [], incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' },
      unit: 'kg', hash: 'h', routine: { id: 'r9', name: 'Leg Day', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }] } }] })
    let scroll, orig
    const frame = () => act(() => { vi.advanceTimersByTime(50) })
    const rerender = () => act(() => root.render(<Stats />))
    beforeEach(() => {
      vi.useFakeTimers()
      mocks.user = { id: 'u2', name: 'Jo' }
      mocks.S = state({ routines: [], customEx: [], week: { 1: ['shared:s1'] } })
      scroll = vi.fn()
      orig = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = scroll
    })
    afterEach(() => {
      Element.prototype.scrollIntoView = orig
      mocks.user = null; mocks.shares = null
      vi.useRealTimers()
    })

    it('scrolls once when the shares are ready before Stats mounts, and not again on later updates', () => {
      window.location.hash = '#/stats?focus=weekly-volume'
      mocks.shares = shareLists()
      rerender()
      expect(card()).toBeTruthy()
      frame()
      expect(scroll).toHaveBeenCalledTimes(1)
      expect(scroll.mock.contexts[0]).toBe(card())
      mocks.shares = shareLists(); rerender(); frame()
      mocks.S = { ...mocks.S }; rerender(); frame()
      expect(scroll).toHaveBeenCalledTimes(1)
    })

    it('scrolls once when the shares arrive after the first frame, and not again when they reload', () => {
      window.location.hash = '#/stats?focus=weekly-volume'
      rerender()
      frame()
      expect(card()).toBeNull()
      expect(scroll).not.toHaveBeenCalled()
      mocks.shares = shareLists(); rerender()
      expect(card()).toBeTruthy()
      frame()
      expect(scroll).toHaveBeenCalledTimes(1)
      expect(scroll.mock.contexts[0]).toBe(card())
      // the share drops out and comes back: the card returns, the page stays where the user is
      mocks.shares = null; rerender(); frame()
      expect(card()).toBeNull()
      mocks.shares = shareLists(); rerender(); frame()
      expect(card()).toBeTruthy()
      expect(scroll).toHaveBeenCalledTimes(1)
    })

    it('does not scroll without the focus param, however late the shares arrive', () => {
      window.location.hash = '#/stats'
      rerender(); frame()
      mocks.shares = shareLists(); rerender(); frame()
      expect(card()).toBeTruthy()
      expect(scroll).not.toHaveBeenCalled()
    })
  })
})
