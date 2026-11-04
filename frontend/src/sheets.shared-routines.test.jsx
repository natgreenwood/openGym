// @vitest-environment happy-dom
// NATG-486 in the sheets: a routine shared with you goes on a weekday like your own (AC4, the
// day sheet writes only its `shared:` pointer), starts a workout from the version this device
// holds (AC4, AC8).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./lib/api.js', async orig => ({ ...(await orig()), api: vi.fn(() => new Promise(() => {})) }))

import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { dayAssignSheet, beginWorkout } from './sheets.jsx'
import { EXIDX, registerCustom } from './lib/exercises.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const ME = { id: 'u2', name: 'Jo' }
const LEG = { id: 'r9', name: 'Leg Day', emoji: 'barbell', ex: [{ id: '0025', sets: 2, mode: 'reps', reps: 5, weight: 100 }] }
const accepted = (id, routine = LEG, extra = {}) => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unit: 'kg', hash: 'h' + id, routine, ...extra })
const CUSTOM = { id: 'cx1', n: 'Cable Y-raise', custom: true, bp: 'shoulders', tg: 'delts', eq: 'cable', sm: [], st: [] }
const mounted = []
let host

function install({ incoming = [accepted('s1')], week = {}, unit = 'kg', shares, config = { shares: true }, sharesError = false } = {}) {
  const S = JSON.parse(JSON.stringify(DEF))
  S.unit = unit
  S.week = week
  S.weighIn = false
  S.routines = [{ id: 'r1', name: 'Push Day', ex: [{ id: '0007', sets: 3, reps: 10 }] }]
  S.customEx = [CUSTOM]
  registerCustom(S.customEx)
  useStore.setState({ S, user: ME, config, ready: false, sharesError, shares: shares === undefined ? { uid: 'u2', incoming, outgoing: [], etag: 'e', fetchedAt: 1 } : shares })
}
function openLast() {
  const sheet = useUI.getState().sheets.at(-1)
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return sheet
}
const rowOf = name => [...host.querySelectorAll('.item')].find(r => r.querySelector('.tt')?.textContent === name)

beforeEach(() => { useUI.setState({ sheets: [] }) })
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())); document.body.innerHTML = '' })

describe('the day sheet (AC4)', () => {
  it('lists the routines shared with you under their own heading, and puts the pointer on the day', () => {
    install()
    act(() => dayAssignSheet(1))
    openLast()
    expect(host.textContent).toContain('Shared with you')
    const leg = rowOf('Leg Day')
    expect(leg.querySelector('.ss').textContent).toBe('From Sam Keller · 1 exercise')
    act(() => leg.click())
    const S = useStore.getState().S
    expect(S.week[1]).toEqual(['shared:s1'])
    expect(S.routines.map(r => r.id)).toEqual(['r1'])
  })

  it('never offers a pending share', () => {
    install({ incoming: [{ id: 's2', state: 'pending', from: { id: 'u1', name: 'Sam' }, preview: { name: 'Mobility', exercises: 3 } }] })
    act(() => dayAssignSheet(1))
    openLast()
    expect(rowOf('Mobility')).toBeUndefined()
    expect(host.textContent).not.toContain('Shared with you')
  })

  it('keeps a share that is not available on its day, ticked, so it can be taken off', () => {
    install({ week: { 1: ['shared:s1'] }, incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unavailable: 'custom-exercise' }] })
    useStore.setState({ shares: { ...useStore.getState().shares, names: { s1: 'Leg Day' } } })
    act(() => dayAssignSheet(1))
    openLast()
    const leg = rowOf('Leg Day')
    expect(leg.querySelector('.ss').textContent).toBe('Not available right now')
    act(() => leg.click())
    expect(useStore.getState().S.week[1]).toBeUndefined()
  })
})

describe('starting a workout from a shared routine (AC4, AC7, AC8)', () => {
  it('builds the session from the version on this device, in your unit, and later edits leave it alone', () => {
    install({ unit: 'lb' })
    beginWorkout(['shared:s1'], null)
    const A = useStore.getState().S.active
    expect(A.routineIds).toEqual(['shared:s1'])
    expect(A.name).toBe('Leg Day')
    expect(A.entries.map(e => [e.id, e.rid])).toEqual([['0025', 'shared:s1']])
    expect(A.entries[0].sets[0].w).toBe(220.5)
    // The sharer's edit arrives mid-workout: the running session keeps the version it started with.
    const before = JSON.stringify(A)
    useStore.setState({ shares: { uid: 'u2', incoming: [accepted('s1', { ...LEG, ex: [{ id: '0007', sets: 1, reps: 1 }] }, { hash: 'h2' })], outgoing: [], etag: 'e2', fetchedAt: 2 } })
    expect(JSON.stringify(useStore.getState().S.active)).toBe(before)
  })
})
