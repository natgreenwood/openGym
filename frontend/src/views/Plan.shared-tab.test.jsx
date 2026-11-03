// @vitest-environment happy-dom
// NATG-486: Plan's third tab, Shared, and shared routines on Schedule. The tab is there while
// sharing is on, with a dot and a spoken count while a share waits (AC1). A pending share shows
// its name and count with Accept and Decline, and is never usable (AC2); one that can't be read
// can only be declined. Accepted ones are listed with who shared them; one not available says
// why (AC9). Offline, the tab says how old the routines are and holds the answers back (AC8).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Plan from './Plan.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { S: null, config: null, user: null, shares: null, sharesError: false, sync: { offline: false }, calls: [] }
  state.snapshot = () => ({
    S: state.S, config: state.config, user: state.user, shares: state.shares, sharesError: state.sharesError, sync: state.sync,
    loadShares: () => { state.calls.push(['load']); return Promise.resolve(state.shares) },
    acceptShare: id => { state.calls.push(['accept', id]); return Promise.resolve({ ok: true }) },
    declineShare: id => { state.calls.push(['decline', id]); return Promise.resolve({ ok: true }) },
    update: mut => { const next = structuredClone(state.S); mut(next); state.S = next },
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => (selector ? selector(mocks.snapshot()) : mocks.snapshot())
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
const nav = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', () => ({ useNavigate: () => nav }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('../sheets.jsx', () => ({ starterPlanSheet: vi.fn(), dayAssignSheet: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../components/MiniBodyMap.jsx', () => ({ default: () => null }))

import { confirmSheet } from '../sheets.jsx'

const ME = { id: 'u2', name: 'Jo Patel' }
const LEG = { id: 'r9', name: 'Leg Day', emoji: 'barbell', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }, { id: '0007', sets: 3, reps: 10 }] }
const accepted = (id, routine = LEG, extra = {}) => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unit: 'kg', hash: 'h' + id, routine, ...extra })
const pending = (id, extra = {}) => ({ id, state: 'pending', from: { id: 'u3', name: 'Alex Morgan' }, hash: 'p' + id, preview: { name: 'Mobility Flow', exercises: 8 }, ...extra })

let host, root
beforeEach(() => {
  localStorage.setItem('gym_plan_view', 'shared')
  mocks.S = { unit: 'kg', workouts: [], exWeights: {}, week: { 1: ['shared:s1'] }, dayPlan: {}, routines: [{ id: 'r1', name: 'Push', emoji: null, ex: [] }] }
  mocks.user = ME
  mocks.config = { shares: true }
  mocks.sharesError = false
  mocks.sync = { offline: false }
  mocks.calls = []
  mocks.shares = { uid: 'u2', incoming: [accepted('s1'), pending('s2')], outgoing: [], etag: 'e', fetchedAt: Date.now() }
  vi.mocked(confirmSheet).mockClear()
  nav.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear() })

const render = () => act(() => root.render(<Plan />))
const tabs = () => [...host.querySelectorAll('.plan-views button')]
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)

describe('the Shared tab (AC1)', () => {
  it('sits next to Schedule and Routines, with a dot and a count while a share waits', () => {
    render()
    expect(tabs().map(b => b.textContent)).toEqual(['Schedule', 'Routines', 'Shared'])
    const shared = tabs()[2]
    expect(shared.getAttribute('aria-pressed')).toBe('true')
    expect(shared.getAttribute('aria-label')).toBe('Shared, 1 waiting')
    expect(shared.querySelector('.seg-dot').getAttribute('aria-hidden')).toBe('true')
  })
  it('has no dot once nothing waits', () => {
    mocks.shares = { ...mocks.shares, incoming: [accepted('s1')] }
    render()
    expect(tabs()[2].querySelector('.seg-dot')).toBeNull()
    expect(tabs()[2].getAttribute('aria-label')).toBeNull()
  })
  it('is not there while sharing is off and nothing is shared, and a remembered Shared opens Schedule', () => {
    mocks.config = {}
    mocks.shares = null
    render()
    expect(tabs().map(b => b.textContent)).toEqual(['Schedule', 'Routines'])
    expect(tabs()[0].getAttribute('aria-pressed')).toBe('true')
  })
  it('stays while the config is unknown but this device holds shares (a phone started offline)', () => {
    mocks.config = null
    render()
    expect(tabs().map(b => b.textContent)).toContain('Shared')
    expect(host.textContent).toContain('Leg Day')
  })
})

describe('waiting shares (AC2)', () => {
  it('show their name, who from and how many exercises, with Decline and Accept, and are not tappable', () => {
    render()
    const card = host.querySelector('.shared-pending')
    expect(card.querySelector('.tt').textContent).toBe('Mobility Flow')
    expect(card.querySelector('.ss').textContent).toBe('From Alex Morgan · 8 exercises')
    expect(card.getAttribute('role')).toBe('listitem')
    expect(card.querySelector('[aria-label="Accept Mobility Flow from Alex Morgan"]')).toBeTruthy()
    expect(card.querySelector('[aria-label="Decline Mobility Flow from Alex Morgan"]')).toBeTruthy()
  })
  it('accepts with one tap', async () => {
    render()
    await act(async () => { host.querySelector('[aria-label="Accept Mobility Flow from Alex Morgan"]').click() })
    expect(mocks.calls).toContainEqual(['accept', 's2'])
  })
  it('declines after a confirm that says the sharer isn’t told', async () => {
    render()
    act(() => host.querySelector('[aria-label="Decline Mobility Flow from Alex Morgan"]').click())
    const dialog = vi.mocked(confirmSheet).mock.calls[0][0]
    expect(dialog.title).toBe('Decline Mobility Flow?')
    expect(dialog.message).toBe('It won’t be added to your plan. Alex isn’t told, and can share it with you again later.')
    expect(dialog.danger).toBe(true)
    await act(async () => { dialog.onConfirm() })
    expect(mocks.calls).toContainEqual(['decline', 's2'])
  })
  it('one that can’t be read can be declined but not accepted, and says why (NATG-487)', () => {
    mocks.shares = { ...mocks.shares, incoming: [pending('s3', { preview: undefined, hash: undefined, unavailable: 'unreadable' })] }
    render()
    expect(host.querySelector('[aria-label="Accept Shared routine from Alex Morgan"]').disabled).toBe(true)
    expect(host.querySelector('[aria-label="Decline Shared routine from Alex Morgan"]').disabled).toBe(false)
    expect(host.textContent).toContain('It can’t be read right now, so it can’t be accepted yet. You can still decline it.')
  })
  it('one that holds a custom exercise keeps its preview and Accept, and says why it can’t be trained yet', () => {
    mocks.shares = { ...mocks.shares, incoming: [pending('s4', { unavailable: 'custom-exercise' })] }
    render()
    expect(host.querySelector('[aria-label="Accept Mobility Flow from Alex Morgan"]').disabled).toBe(false)
    expect(host.textContent).toContain('It has a custom exercise right now, so it can’t be trained until Alex swaps it out.')
  })
  it('renders no share value it hasn’t type-checked (SEC-01)', () => {
    mocks.shares = { ...mocks.shares, incoming: [pending('s5', { from: { id: 'u3', name: { toString: 1 } }, preview: { name: 42, exercises: '8' } })] }
    render()
    const card = host.querySelector('.shared-pending')
    expect(card.querySelector('.tt').textContent).toBe('Shared routine')
    expect(card.querySelector('.ss')).toBeNull()
    expect(card.querySelector('[aria-label="Accept Shared routine"]')).toBeTruthy()
    expect(host.textContent).not.toContain('[object Object]')
  })
  it('is never offered as a routine: not in the accepted list, not on a day', () => {
    mocks.shares = { ...mocks.shares, incoming: [pending('s2')] }
    render()
    expect(host.querySelector('.shared-list')).toBeNull()
  })
})

describe('routines shared with you', () => {
  it('list who shared them, how many exercises and their days, and open the read-only view', () => {
    render()
    const row = host.querySelector('[data-shared-row="shared:s1"]')
    expect(row.querySelector('.tt').textContent).toBe('Leg Day')
    expect(row.querySelector('.ss').textContent).toBe('From Sam Keller · 2 exercises · Mo')
    expect(row.querySelector('.shared-badge')).toBeTruthy()
    act(() => row.click())
    expect(nav).toHaveBeenCalledWith('/plan/r/' + encodeURIComponent('shared:s1'))
    expect(host.textContent).toContain('These follow the owner’s changes and can’t be edited.')
  })
  it('one not available right now says why, under its last known name (AC9)', () => {
    mocks.shares = { ...mocks.shares, incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unavailable: 'custom-exercise' }], names: { s1: 'Leg Day' } }
    render()
    const row = host.querySelector('[data-shared-row="shared:s1"]')
    expect(row.querySelector('.tt').textContent).toBe('Leg Day')
    expect(row.querySelector('.ss').textContent).toBe('Not available · Sam added a custom exercise')
  })
})

describe('empty, loading, failed and offline', () => {
  it('says nothing is shared yet', () => {
    mocks.shares = { ...mocks.shares, incoming: [] }
    render()
    expect(host.textContent).toContain('Nothing shared with you yet.')
  })
  it('shows a loading placeholder before the first answer', () => {
    mocks.shares = null
    render()
    expect(host.querySelector('.share-skel[role="status"]')).toBeTruthy()
  })
  it('says the lists couldn’t be loaded, with a retry', () => {
    mocks.shares = null
    mocks.sharesError = true
    render()
    expect(host.querySelector('[role="alert"]').textContent).toContain('Couldn’t load what’s shared with you.')
    mocks.calls = []
    act(() => button('Try again').click())
    expect(mocks.calls).toContainEqual(['load'])
  })
  it('offline: says how old the routines are, keeps them, and holds Accept and Decline back', () => {
    mocks.sync = { offline: true }
    render()
    const notice = host.querySelector('.shared-notice[role="status"]')
    expect(notice.textContent).toMatch(/^You’re offlineShared routines are as they were at .+ today\. You can still schedule and train them\.$/)
    expect(host.querySelector('[aria-label="Accept Mobility Flow from Alex Morgan"]').disabled).toBe(true)
    expect(host.querySelector('[aria-label="Decline Mobility Flow from Alex Morgan"]').disabled).toBe(true)
    expect(host.textContent).toContain('Connect to accept or decline.')
    expect(host.querySelector('[data-shared-row="shared:s1"]')).toBeTruthy()
  })
})

describe('Schedule with shared routines (AC4, AC9)', () => {
  beforeEach(() => localStorage.setItem('gym_plan_view', 'schedule'))
  const dayRow = d => host.querySelector(`.plan-day[data-day="${d}"]`)
  it('shows a shared routine on its day with the people badge and who it is from', () => {
    render()
    expect(dayRow(1).querySelector('.tt').textContent).toBe('Leg Day')
    expect(dayRow(1).querySelector('.ss').textContent).toBe('From Sam Keller · 2 exercises')
    expect(dayRow(1).querySelector('.shared-badge')).toBeTruthy()
  })
  it('doesn’t call a plan made only of shared routines empty', () => {
    mocks.S = { ...mocks.S, routines: [] }
    render()
    expect(host.textContent).not.toContain('No routines yet.')
    mocks.shares = { ...mocks.shares, incoming: [] }
    render()
    expect(host.textContent).toContain('No routines yet.')
  })
  it('keeps a day whose shared routine is not available, and says so instead of rest', () => {
    mocks.shares = { ...mocks.shares, incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unavailable: 'custom-exercise' }], names: { s1: 'Leg Day' } }
    render()
    expect(dayRow(1).querySelector('.tt').textContent).toBe('Leg Day')
    expect(dayRow(1).querySelector('.ss').textContent).toBe('Not available · Sam added a custom exercise')
  })
})
