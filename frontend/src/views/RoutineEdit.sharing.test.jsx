// @vitest-environment happy-dom
// NATG-485: the routine page's Sharing section, as the sharer sees it. The share action shows only
// while sharing is available (AC2), is unavailable with its reason for a routine with a custom
// exercise (AC4), and the people a routine is shared with are listed without any state, each with
// Unshare (AC5). While a routine is shared, the editor turns a custom exercise away (AC4).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const answers = vi.hoisted(() => ({ shares: { incoming: [], outgoing: [], etag: 'e' } }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(path => path === '/api/shares' ? Promise.resolve(answers.shares) : Promise.resolve({ ok: true }))
}))
vi.mock('../sheets.jsx', () => ({ exConfigSheet: vi.fn(), exercisePicker: vi.fn(() => ({ close: vi.fn() })), glyphPicker: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../components/Media.jsx', () => ({ Thumb: () => null }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null }))

import RoutineEdit from './RoutineEdit.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { exercisePicker, confirmSheet } from '../sheets.jsx'
import { EXIDX } from '../lib/exercises.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host

const ME = { id: 'u1', name: 'Sam Keller' }
const CUSTOM = { id: 'c-yraise', n: 'Cable Y-raise', custom: true, bp: 'shoulders', eq: 'cable' }
const out = (id, to, routineId = 'r1') => ({ id, to, routineId, created: '2026-11-03T00:00:00Z' })

async function mount({ ex = [{ id: '0025', sets: 3, mode: 'reps', reps: 5, weight: 80 }], config = { shares: true }, user = ME, customEx = [] } = {}) {
  const S = JSON.parse(JSON.stringify(DEF))
  S.routines = [{ id: 'r1', name: 'Push Day', emoji: 'dumbbell', ex }]
  S.customEx = customEx
  if (user) localStorage.setItem('gym_owner', user.id); else localStorage.removeItem('gym_owner')   // as setUser signs in, or out
  useStore.setState({ S, user, config, shares: null, sharesError: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<MemoryRouter initialEntries={['/plan/r/r1']}><Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /></Routes></MemoryRouter>))
  await act(() => new Promise(r => setTimeout(r, 0)))
}
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const shareCalls = () => api.mock.calls.filter(([p]) => p.startsWith('/api/shares'))

beforeEach(() => {
  vi.clearAllMocks()
  answers.shares = { incoming: [], outgoing: [], etag: 'e' }
  useUI.setState({ sheets: [] })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Sharing section: only while sharing is available (AC2)', () => {
  it('is absent while the admin option is off: /api/config has no `shares`', async () => {
    await mount({ config: { media: {} } })
    expect(host.textContent).not.toContain('Sharing')
    expect(button('Share with people')).toBeUndefined()
    expect(shareCalls()).toEqual([])
  })
  it('is absent when signed out', async () => {
    await mount({ user: null })
    expect(button('Share with people')).toBeUndefined()
    expect(shareCalls()).toEqual([])
  })
  // Local mode on a phone is no user and no server answer: the config is never fetched (null).
  it('is absent in local mode, where there is no user and no config', async () => {
    await mount({ user: null, config: null })
    expect(button('Share with people')).toBeUndefined()
    expect(shareCalls()).toEqual([])
  })
  it('shows the share action once sharing is on, and asks whom it is shared with', async () => {
    await mount()
    expect(host.querySelector('.sect-t').textContent).toBe('Sharing')
    expect(button('Share with people')).toBeTruthy()
    expect(api).toHaveBeenCalledWith('/api/shares')
    expect(host.textContent).toContain('They’ll find it in Plan › Shared once they accept.')
  })
})

describe('share action (AC3)', () => {
  it('opens the share sheet', async () => {
    await mount()
    act(() => button('Share with people').click())
    expect(useUI.getState().sheets).toHaveLength(1)
  })
})

describe('custom exercises (AC4)', () => {
  it('makes the action unavailable, focusable, with the reason in the row', async () => {
    await mount({ ex: [{ id: '0025', sets: 3 }, { id: CUSTOM.id, sets: 3 }], customEx: [CUSTOM] })
    const row = host.querySelector('.share-off')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.disabled).toBe(false)
    const reason = host.querySelector('#' + CSS.escape(row.getAttribute('aria-describedby')))
    expect(reason.textContent).toBe('Has a custom exercise (Cable Y-Raise), so it can’t be shared.')
    act(() => row.click())
    expect(useUI.getState().sheets).toHaveLength(0)
    expect(host.textContent).toContain('Swap the custom exercise for one from the library to share this routine.')
  })

  it('turns a custom exercise away while the routine is shared, and says to unshare first', async () => {
    answers.shares = { incoming: [], outgoing: [out('s1', { id: 'u2', name: 'Jo Patel' }), out('s2', { id: 'u3', name: 'Alex Morgan' })], etag: 'e' }
    await mount({ customEx: [CUSTOM] })
    act(() => button('Add exercise').click())
    const onPick = exercisePicker.mock.calls[0][0]
    act(() => onPick(CUSTOM, true))
    expect(useStore.getState().S.routines[0].ex.map(e => e.id)).toEqual(['0025'])
    expect(confirmSheet).toHaveBeenCalledOnce()
    const dialog = confirmSheet.mock.calls[0][0]
    expect(dialog.title).toBe('Unshare first')
    expect(dialog.message).toBe('Push Day is shared with 2 people. Custom exercises can’t go in a shared routine, so unshare it before adding Cable Y-Raise.')
    expect(dialog.confirmText).toBe('Manage sharing')
    expect(dialog.cancelText).toBe('Not now')
    // A library exercise still goes in as before.
    act(() => onPick(EXIDX['0025'], true))
    expect(useStore.getState().S.routines[0].ex).toHaveLength(2)
  })

  it('lets a custom exercise in while the routine is shared with nobody', async () => {
    await mount({ customEx: [CUSTOM] })
    act(() => button('Add exercise').click())
    act(() => exercisePicker.mock.calls[0][0](CUSTOM, true))
    expect(confirmSheet).not.toHaveBeenCalled()
    expect(useStore.getState().S.routines[0].ex.map(e => e.id)).toEqual(['0025', CUSTOM.id])
  })
})

describe('shared-with list (AC5)', () => {
  beforeEach(() => {
    answers.shares = {
      // `incoming` is someone else's routine shared with me: never listed here.
      incoming: [{ id: 'in1', state: 'pending', from: { id: 'u9', name: 'Uma Ito' } }],
      outgoing: [out('s1', { id: 'u3', name: 'Tom Becker' }), out('s2', { id: 'u2', name: 'Alex Morgan' }), out('s3', { id: 'u4', name: 'Priya Shah' }, 'r-other')],
      etag: 'e'
    }
  })

  it('lists whom this routine is shared with, by name, with no state', async () => {
    await mount()
    const rows = [...host.querySelectorAll('.share-row')]
    expect(rows.map(r => r.querySelector('.lrow-t').textContent)).toEqual(['Alex Morgan', 'Tom Becker'])
    expect(host.textContent).not.toMatch(/pending|accepted|declined|removed/i)
    expect(button('Share with more people')).toBeTruthy()
    expect(rows.every(r => r.querySelector('button').textContent === 'Unshare')).toBe(true)
  })

  it('unshares from one person after a confirm, and loads the list again', async () => {
    await mount()
    const unshareTom = host.querySelector('[aria-label="Unshare with Tom Becker"]')
    act(() => unshareTom.click())
    const dialog = confirmSheet.mock.calls[0][0]
    expect(dialog.title).toBe('Stop sharing with Tom Becker?')
    expect(dialog.message).toBe('Push Day leaves Tom’s Shared tab and every day it’s on in their plan. Your routine stays as it is.')
    expect(dialog.danger).toBe(true)
    api.mockClear()
    await act(async () => { dialog.onConfirm(); await new Promise(r => setTimeout(r, 0)) })
    expect(api).toHaveBeenCalledWith('/api/shares/s1', { method: 'DELETE' })
    expect(api).toHaveBeenCalledWith('/api/shares')
  })

  it('says so and offers a retry when the list cannot be loaded', async () => {
    api.mockImplementation(path => path === '/api/shares' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({}))
    await mount()
    expect(host.textContent).toContain('Couldn’t check who has this routine.')
    expect(button('Try again')).toBeTruthy()
    // The share action itself stays available: sharing does not need the list.
    expect(button('Share with people')).toBeTruthy()
  })
})
