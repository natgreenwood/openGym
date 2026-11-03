// @vitest-environment happy-dom
// NATG-486, carried over from the NATG-485 review: with the share list kept on this device, the
// editor's custom-exercise guard (`turnAway`) no longer lets a custom exercise in while the list
// isn't known. It goes by the kept list when the server can't be asked, and with no list at all
// it turns the exercise away: "couldn't check" when the load failed, "still checking" before it
// has answered.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ mode: 'fail' }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(path => {
    if (path !== '/api/shares') return Promise.resolve({ ok: true })
    if (net.mode === 'fail') return Promise.reject(new TypeError('Failed to fetch'))
    return new Promise(() => {})   // never answers: still loading
  }),
  setRemoteAuth: vi.fn(),
}))
vi.mock('../sheets.jsx', () => ({ exConfigSheet: vi.fn(), exercisePicker: vi.fn(() => ({ close: vi.fn() })), glyphPicker: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../components/Media.jsx', () => ({ Thumb: () => null }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null }))

import RoutineEdit from './RoutineEdit.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exercisePicker, confirmSheet } from '../sheets.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host
const ME = { id: 'u1', name: 'Sam Keller' }
const CUSTOM = { id: 'c-yraise', n: 'Cable Y-raise', custom: true, bp: 'shoulders', eq: 'cable' }

async function mount({ shares = null, config = { shares: true } } = {}) {
  const S = JSON.parse(JSON.stringify(DEF))
  S.routines = [{ id: 'r1', name: 'Push Day', emoji: 'dumbbell', ex: [{ id: '0025', sets: 3, mode: 'reps', reps: 5, weight: 80 }] }]
  S.customEx = [CUSTOM]
  useStore.setState({ S, user: ME, config, shares, sharesError: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<MemoryRouter initialEntries={['/plan/r/r1']}><Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /></Routes></MemoryRouter>))
  await act(() => new Promise(r => setTimeout(r, 0)))
}
const pickCustom = () => {
  act(() => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add exercise').click())
  act(() => exercisePicker.mock.calls.at(-1)[0](CUSTOM, true))
}
const exIds = () => useStore.getState().S.routines[0].ex.map(e => e.id)

beforeEach(() => { vi.clearAllMocks(); useUI.setState({ sheets: [] }) })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('turnAway with no list from the server', () => {
  it('goes by the list kept on this device when the server can’t be asked', async () => {
    net.mode = 'fail'
    await mount({ shares: { uid: 'u1', incoming: [], outgoing: [{ id: 's1', routineId: 'r1', to: { id: 'u2', name: 'Jo' } }], etag: 'old' } })
    pickCustom()
    expect(exIds()).toEqual(['0025'])
    expect(confirmSheet.mock.calls[0][0].title).toBe('Unshare first')
  })

  it('goes by the kept list while the config is unknown, as on a phone that starts offline', async () => {
    net.mode = 'fail'
    await mount({ config: null, shares: { uid: 'u1', incoming: [], outgoing: [{ id: 's1', routineId: 'r1', to: { id: 'u2', name: 'Jo' } }], etag: 'old' } })
    pickCustom()
    expect(exIds()).toEqual(['0025'])
    expect(confirmSheet.mock.calls[0][0].title).toBe('Unshare first')
  })

  it('lets a custom exercise in with no config and no kept list: nothing says this routine is shared', async () => {
    net.mode = 'fail'
    await mount({ config: null })
    pickCustom()
    expect(confirmSheet).not.toHaveBeenCalled()
    expect(exIds()).toEqual(['0025', CUSTOM.id])
  })

  it('turns a custom exercise away when the list couldn’t be loaded, and says it couldn’t check', async () => {
    net.mode = 'fail'
    await mount()
    pickCustom()
    expect(exIds()).toEqual(['0025'])
    const dialog = confirmSheet.mock.calls[0][0]
    expect(dialog.title).toBe('Couldn’t check who has this routine')
    expect(dialog.message).toBe('Custom exercises can’t go in a shared routine, and the list of people you share Push Day with couldn’t be loaded. Try again once you’re online.')
    expect(dialog.confirmText).toBe('Try again')
  })

  it('turns it away while the list is still loading', async () => {
    net.mode = 'hang'
    await mount()
    pickCustom()
    expect(exIds()).toEqual(['0025'])
    expect(confirmSheet.mock.calls[0][0].title).toBe('Still checking who has this routine')
  })

  it('still lets a custom exercise into a routine the kept list says is shared with nobody', async () => {
    net.mode = 'fail'
    await mount({ shares: { uid: 'u1', incoming: [], outgoing: [], etag: 'old' } })
    pickCustom()
    expect(confirmSheet).not.toHaveBeenCalled()
    expect(exIds()).toEqual(['0025', CUSTOM.id])
  })
})
