// @vitest-environment happy-dom
// NATG-650: while the running workout is too large to send to the Apple Watch (lib/watch-sync.js
// refusedWorkout), the workout screen says so in its header, in a status region that is always
// there, so a screen reader hears the line when it appears. Only for that workout.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refused = vi.hoisted(() => ({ wid: null, listeners: new Set() }))
vi.mock('../lib/watch-sync.js', async importOriginal => ({
  ...(await importOriginal()),
  refusedWorkout: () => refused.wid,
  onRefusedWorkout: fn => { refused.listeners.add(fn); return () => refused.listeners.delete(fn) },
}))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), chime: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})), beacon: vi.fn(), appBase: () => '/' }))

import Workout, { _resetHintQuiet } from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = v => JSON.parse(JSON.stringify(v))
const TEXT = 'This workout is too large to send to your Apple Watch, so the watch isn’t showing the latest version.'
let root, container

const refuse = wid => act(() => { refused.wid = wid; refused.listeners.forEach(fn => fn()) })
const mount = (view = 'cards') => {
  const S = clone(DEF)
  S.hints = { swipeSets: true }
  S.active = { id: 'w-big', d: '2026-11-10', start: Date.now(), name: 'Big day', cur: 0, workoutView: view,
    entries: [{ id: '0025', target: { sets: 2, reps: 8, weight: 60 }, sets: [{ w: 60, r: 8, done: false }, { w: 60, r: 8, done: false }] }] }
  useStore.setState({ S, user: null })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}
const status = () => container.querySelectorAll('[role="status"]')
const notice = () => [...status()].find(el => el.parentElement?.classList.contains('whdr'))

beforeEach(() => {
  _resetHintQuiet()
  refused.wid = null; refused.listeners.clear()
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null, swipeHint: null })
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('the workout is too large for the watch', () => {
  it('keeps an empty status region in the header while nothing is refused', () => {
    mount()
    const el = notice()
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('')
    expect(el.children).toHaveLength(0)
  })

  it('says so in that region, last in the header, with the icon hidden from screen readers', () => {
    mount()
    const el = notice()
    refuse('w-big')
    // the same element: a region that appears with its text is often not announced
    expect(notice()).toBe(el)
    expect(el.textContent).toBe(TEXT)
    expect(el.parentElement.lastElementChild).toBe(el)
    const icon = el.querySelector('svg[data-icon="watch"]')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('.muted.small')).toBeTruthy()
  })

  it('clears when the refusal is over (AC3)', () => {
    mount()
    refuse('w-big')
    expect(notice().textContent).toBe(TEXT)
    refuse(null)
    expect(notice().textContent).toBe('')
  })

  it('says nothing about another workout refused', () => {
    mount()
    refuse('w-other')
    expect(notice().textContent).toBe('')
  })

  it('rides in the pinned header in the list', () => {
    mount('list')
    refuse('w-big')
    expect(notice().closest('.whdr').classList.contains('stick')).toBe(true)
    expect(notice().textContent).toBe(TEXT)
  })

  it('is there when the screen opens on a workout already refused', () => {
    refused.wid = 'w-big'
    mount()
    expect(notice().textContent).toBe(TEXT)
  })
})
