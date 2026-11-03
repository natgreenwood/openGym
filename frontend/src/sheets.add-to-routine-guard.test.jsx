// @vitest-environment happy-dom
// NATG-486, carried over from the NATG-485 review: Library's "Add to routine" holds a custom
// exercise back from every routine while no share list is known, loading or failed, and says
// which. With a list (fresh or kept on this device) it goes by it, as before.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./lib/api.js', async orig => ({ ...(await orig()), api: vi.fn(() => new Promise(() => {})) }))

import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { addToRoutineSheet } from './sheets.jsx'
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

describe('Add to routine with no share list known (NATG-485 gap)', () => {
  it('holds a custom exercise back from every routine while the list is still loading', () => {
    install({ shares: null })
    act(() => addToRoutineSheet(EXIDX.cx1))
    openLast()
    const push = rowOf('Push Day')
    expect(push.getAttribute('aria-disabled')).toBe('true')
    expect(host.querySelector('#' + push.getAttribute('aria-describedby')).textContent).toBe('Checking who has it')
    expect(rowOf('New routine').getAttribute('aria-disabled')).toBeNull()
  })

  it('says it couldn’t check when the load failed', () => {
    install({ shares: null, sharesError: true })
    act(() => addToRoutineSheet(EXIDX.cx1))
    openLast()
    const push = rowOf('Push Day')
    expect(host.querySelector('#' + push.getAttribute('aria-describedby')).textContent).toBe('Couldn’t check who has it')
  })

  it('holds nothing back for a library exercise', () => {
    install({ shares: null })
    act(() => addToRoutineSheet(EXIDX['0025']))
    openLast()
    expect(rowOf('Push Day').getAttribute('aria-disabled')).toBeNull()
  })

  it('goes by the kept list while the config is unknown, as on a phone that starts offline', () => {
    install({ config: null, shares: { uid: 'u2', incoming: [], outgoing: [{ id: 'o1', routineId: 'r1', to: { id: 'u3', name: 'Alex' } }], etag: 'old' } })
    act(() => addToRoutineSheet(EXIDX.cx1))
    openLast()
    const push = rowOf('Push Day')
    expect(push.getAttribute('aria-disabled')).toBe('true')
    expect(host.querySelector('#' + push.getAttribute('aria-describedby')).textContent).toBe('Shared, unshare first')
  })

  it('with the config unknown, leaves a routine the kept list doesn’t name open to it', () => {
    install({ config: null, shares: { uid: 'u2', incoming: [], outgoing: [], etag: 'old' } })
    act(() => addToRoutineSheet(EXIDX.cx1))
    openLast()
    expect(rowOf('Push Day').getAttribute('aria-disabled')).toBeNull()
  })
})
