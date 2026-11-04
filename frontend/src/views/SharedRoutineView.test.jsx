// @vitest-environment happy-dom
// NATG-486: a routine shared with you opens read-only at /plan/r/shared:<id>. No rename, glyph
// picker, progression picker, deload switch, add, reorder, link, remove-exercise, copy, print or
// share (AC5); values in your units and your exercise-name language (AC7); the one action is
// "Remove from my plan" after a confirm (AC6). One not available says why and offers only Remove (AC9).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({ ok: true })), setRemoteAuth: vi.fn() }))
vi.mock('../sheets.jsx', () => ({ exConfigSheet: vi.fn(), exercisePicker: vi.fn(), glyphPicker: vi.fn(), confirmSheet: vi.fn(), exerciseDetailSheet: vi.fn() }))
vi.mock('../components/Media.jsx', () => ({ Thumb: () => null }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null }))

import RoutineEdit from './RoutineEdit.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { confirmSheet, exerciseDetailSheet, exercisePicker, glyphPicker } from '../sheets.jsx'
import { exerciseNameFor } from '../lib/i18n.js'
import { EXIDX } from '../lib/exercises.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const ME = { id: 'u2', name: 'Jo Patel' }
const LEG = { id: 'r9', name: 'Leg Day', emoji: 'barbell', prog: 'double', ex: [{ id: '0025', sets: 5, mode: 'reps', reps: 5, weight: 100 }] }
const accepted = (extra = {}) => ({ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unit: 'kg', hash: 'h1', routine: LEG, ...extra })
let root, host, path

async function mount({ incoming = [accepted()], unit = 'lb', week = { 6: ['shared:s1'] }, names } = {}) {
  const S = JSON.parse(JSON.stringify(DEF))
  S.unit = unit
  S.week = week
  S.routines = [{ id: 'r1', name: 'Push', ex: [] }]
  useStore.setState({ S, user: ME, config: { shares: true }, ready: true, shares: { uid: 'u2', incoming, outgoing: [], etag: 'e', fetchedAt: 1, names } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  path = null
  const Where = () => { path = 'plan'; return null }
  act(() => root.render(<MemoryRouter initialEntries={['/plan/r/' + encodeURIComponent('shared:s1')]}>
    <Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /><Route path="/plan" element={<Where />} /></Routes>
  </MemoryRouter>))
  await act(() => new Promise(r => setTimeout(r, 0)))
}
const buttons = () => [...host.querySelectorAll('button')].map(b => b.textContent.trim() || b.getAttribute('aria-label'))

beforeEach(() => { vi.clearAllMocks(); useUI.setState({ sheets: [] }) })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('read-only view (AC5, AC7)', () => {
  it('shows the routine, who shared it and its progression as text, with nothing to edit', async () => {
    await mount()
    expect(host.querySelector('h1').textContent).toBe('Leg Day')
    expect(host.querySelector('input, textarea, select')).toBeNull()
    expect(host.textContent).toContain('Shared by Sam Keller')
    expect(host.textContent).toContain('Read-only. Sam’s changes show up here after the next sync.')
    expect(host.textContent).toContain('Double progression')
    // Back and the one action; nothing else is a button.
    expect(buttons()).toEqual(['Plan', 'Remove from my plan'])
    for (const word of ['Add exercise', 'Copy routine', 'Print / Save as PDF', 'Delete routine', 'Share with people', 'Pick an icon', 'Move up', 'Move down']) {
      expect(host.textContent + buttons().join('|')).not.toContain(word)
    }
    expect(host.querySelector('.routine-grip, [data-drag-handle]')).toBeNull()
    expect(exercisePicker).not.toHaveBeenCalled()
    expect(glyphPicker).not.toHaveBeenCalled()
  })

  it('shows weights in your unit and names in your language (AC7)', async () => {
    await mount({ unit: 'lb' })
    const row = host.querySelector('.routine-list .item')
    expect(row.querySelector('.tt').textContent).toBe(exerciseNameFor(EXIDX['0025']))
    expect(row.querySelector('.ss').textContent).toContain('220.5')
    expect(row.querySelector('.ss').textContent).toContain('lb')
    expect(host.textContent).toContain('Weights and speeds are in your units.')
  })

  it('opens how to do an exercise on a tap, and nothing that edits it', async () => {
    await mount()
    act(() => host.querySelector('.routine-list .item').click())
    expect(exerciseDetailSheet).toHaveBeenCalledOnce()
  })
})

describe('Remove from my plan (AC6)', () => {
  it('asks first, then removes it through the server and goes back to Plan', async () => {
    await mount()
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Remove from my plan').click())
    const dialog = vi.mocked(confirmSheet).mock.calls[0][0]
    expect(dialog.title).toBe('Remove Leg Day?')
    expect(dialog.message).toBe('It leaves your Shared tab and every day it’s on in your schedule. Sam’s routine isn’t affected, and your logged workouts stay as they are.')
    expect(dialog.danger).toBe(true)
    await act(async () => { await dialog.onConfirm(); await new Promise(r => setTimeout(r, 0)) })
    expect(api).toHaveBeenCalledWith('/api/shares/s1', { method: 'DELETE' })
    expect(useStore.getState().S.week[6]).toBeUndefined()
    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['r1'])
    expect(path).toBe('plan')
  })
})

describe('not available right now (AC9)', () => {
  it('says why and where it stays, offers only Remove, and shows no exercises', async () => {
    await mount({ incoming: [{ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unavailable: 'custom-exercise' }], names: { s1: 'Leg Day' } })
    expect(host.querySelector('h1').textContent).toBe('Leg Day')
    const notice = host.querySelector('.shared-notice[role="status"]')
    expect(notice.textContent).toBe('Not available right nowSam Keller added a custom exercise to Leg Day, and shared routines can’t include those. It stays on Sa in your schedule and comes back as soon as Sam removes it.')
    expect(host.querySelector('.routine-list')).toBeNull()
    expect(buttons()).toEqual(['Plan', 'Remove from my plan'])
  })
})

describe('a share that has ended', () => {
  it('goes back to Plan', async () => {
    await mount({ incoming: [] })
    expect(path).toBe('plan')
  })
})
