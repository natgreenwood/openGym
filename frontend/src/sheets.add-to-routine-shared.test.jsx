// @vitest-environment happy-dom
// NATG-485 (Architect's review, point 1): Library › "Add to my plan" must not put a custom exercise
// into a routine that is shared. That routine's row says so and does nothing; every other routine,
// and "New routine", stay as they were. A library exercise is never held back.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./lib/api.js', async orig => ({ ...(await orig()), api: vi.fn(() => Promise.resolve({ incoming: [], outgoing: [] })) }))

import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { addToRoutineSheet } from './sheets.jsx'
import { EXIDX, registerCustom } from './lib/exercises.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const CUSTOM = { id: 'cx1', n: 'Cable Y-raise', custom: true, bp: 'shoulders', tg: 'delts', eq: 'cable', sm: [], st: [] }
const ME = { id: 'u1', name: 'Sam' }
const mounted = []
let host

function install({ config = { shares: true }, outgoing = [{ id: 's1', to: { id: 'u2', name: 'Jo' }, routineId: 'r1' }] } = {}) {
  const S = JSON.parse(JSON.stringify(DEF))
  S.routines = [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3 }] }, { id: 'r2', name: 'Pull Day', ex: [] }]
  S.customEx = [CUSTOM]
  registerCustom(S.customEx)
  useStore.setState({ S, user: ME, config, shares: { uid: 'u1', incoming: [], outgoing, etag: 'e' } })
}
function open(ex) {
  act(() => addToRoutineSheet(ex))
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

describe('Add to routine: a custom exercise and a shared routine', () => {
  it('holds the shared routine back for a custom exercise, and says why', () => {
    install()
    const sheet = open(EXIDX.cx1)
    const push = rowOf('Push Day')
    expect(push.getAttribute('aria-disabled')).toBe('true')
    expect(host.querySelector('#' + push.getAttribute('aria-describedby')).textContent).toBe('Shared, unshare first')
    act(() => push.click())
    // Nothing happened: the same sheet is still the one open, and the routine is unchanged.
    expect(useUI.getState().sheets.map(s => s.id)).toEqual([sheet.id])
    expect(useStore.getState().S.routines[0].ex.map(e => e.id)).toEqual(['0025'])
  })

  it('leaves the unshared routines and "New routine" open to it', () => {
    install()
    const sheet = open(EXIDX.cx1)
    expect(rowOf('Pull Day').getAttribute('aria-disabled')).toBeNull()
    expect(rowOf('Pull Day').getAttribute('role')).toBe('button')
    expect(rowOf('New routine').getAttribute('aria-disabled')).toBeNull()
    act(() => rowOf('Pull Day').click())
    // The picker closed and the exercise's settings opened, as before.
    const open_ = useUI.getState().sheets
    expect(open_).toHaveLength(1)
    expect(open_[0].id).not.toBe(sheet.id)
  })

  it('holds nothing back for a library exercise', () => {
    install()
    open(EXIDX['0025'])
    expect(rowOf('Push Day').getAttribute('aria-disabled')).toBeNull()
    expect(host.textContent).not.toContain('Shared, unshare first')
  })

  it('holds nothing back while sharing is unavailable', () => {
    install({ config: {} })
    open(EXIDX.cx1)
    expect(rowOf('Push Day').getAttribute('aria-disabled')).toBeNull()
  })
})
