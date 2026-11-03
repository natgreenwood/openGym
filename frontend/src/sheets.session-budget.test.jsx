// @vitest-environment happy-dom
// SEC-486-01, the rest, in the sheets: a start that would build more than MAX_ROUTINE_ROWS rows is
// refused (no session, nothing built, never a freestyle session in its place), and Add routine
// offers a routine that would take the session past the cap disabled, with the reason, and
// refuses it before a row is built if the session grew while the sheet was open.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./lib/api.js', async orig => ({ ...(await orig()), api: vi.fn(() => new Promise(() => {})) }))
vi.mock('./lib/session-start.js', async orig => { const m = await orig(); return { ...m, buildSessionEntries: vi.fn(m.buildSessionEntries) } })

import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { beginWorkout, startFlow, addRoutineToSessionSheet } from './sheets.jsx'
import { buildSessionEntries } from './lib/session-start.js'
import { setNav } from './lib/nav.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const ME = { id: 'u2', name: 'Jo' }
const big = (id, exId) => ({ id, name: id.toUpperCase(), ex: Array.from({ length: 10 }, () => ({ id: exId, sets: 50, reps: 5, weight: 60 })) })
const small = { id: 's', name: 'Small', ex: [{ id: '0001', sets: 3, reps: 10 }] }
const toast = () => useUI.getState().toastMsg
let mounted = []

beforeEach(() => {
  setNav(vi.fn())
  const S = JSON.parse(JSON.stringify(DEF))
  S.weighIn = false
  S.routines = [big('a', '0025'), big('b', '0007'), small]
  useStore.setState({ S, user: ME, config: {}, ready: false, shares: null })
  useUI.setState({ sheets: [], toastMsg: '' })
  buildSessionEntries.mockClear()
})
afterEach(() => { mounted.splice(0).forEach(([r, h]) => { act(() => r.unmount()); h.remove() }) })

const openTop = () => {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host); mounted.push([root, host])
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const rowOf = (host, name) => [...host.querySelectorAll('.item')].find(r => r.querySelector('.tt')?.textContent === name)

describe('starting more than one session can hold', () => {
  it('refuses two combined 500-row routines before a row is built, and starts nothing', () => {
    startFlow(['a', 'b'])
    expect(useStore.getState().S.active).toBeFalsy()
    expect(buildSessionEntries).not.toHaveBeenCalled()
    expect(toast()).toContain('more than one workout can hold')
    // The same from a path that skips startFlow (the watch): no freestyle session in its place.
    beginWorkout(['a', 'b'], null)
    expect(useStore.getState().S.active).toBeFalsy()
    expect(buildSessionEntries).not.toHaveBeenCalled()
  })
  it('starts one of them, at exactly the cap', () => {
    startFlow(['a'])
    expect(useStore.getState().S.active.routineIds).toEqual(['a'])
  })
})

describe('Add routine past the cap', () => {
  it('offers the routine that would cross the cap disabled, with the reason', () => {
    beginWorkout(['a'], null)
    act(() => addRoutineToSessionSheet())
    const host = openTop()
    const b = rowOf(host, 'B')
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(b.querySelector('.tag').textContent).toBe('too much for this workout')
    const before = JSON.stringify(useStore.getState().S.active)
    buildSessionEntries.mockClear()
    act(() => b.click())
    expect(JSON.stringify(useStore.getState().S.active)).toBe(before)
    expect(buildSessionEntries).not.toHaveBeenCalled()
  })
  it('turns a routine that fitted when the sheet opened away once the session has grown', () => {
    useStore.setState({ S: { ...useStore.getState().S, routines: [big('a', '0025'), small, { id: 'c', name: 'C', ex: [{ id: '0007', sets: 5, reps: 5 }] }] } })
    beginWorkout(['s'], null)
    act(() => addRoutineToSessionSheet())
    const host = openTop()
    expect(rowOf(host, 'C').getAttribute('aria-disabled')).toBeNull()
    // While the sheet is open the session grows (rows added from the workout screen).
    act(() => { useStore.getState().update(s => { s.active.entries.push({ id: '0025', rid: 'x', sets: Array.from({ length: 495 }, () => ({ w: 60, r: 5, done: false })) }) }) })
    const c = rowOf(host, 'C')
    expect(c.getAttribute('aria-disabled')).toBe('true')
    expect(c.querySelector('.tag').textContent).toBe('too much for this workout')
    const before = JSON.stringify(useStore.getState().S.active)
    buildSessionEntries.mockClear()
    act(() => c.click())
    expect(JSON.stringify(useStore.getState().S.active)).toBe(before)
    expect(buildSessionEntries).not.toHaveBeenCalled()
  })
  it('counts a per-side session’s drops on each side: a routine that would cross the cap is refused before a row is built', () => {
    // 20 per-side sets with 10 drops on each side: 440 rows as built (the earlier count, the
    // parent rows only, made it 40 and let 100 more in).
    const unilateral = { id: 'u', name: 'Unilateral', ex: [{ id: '0025', side: true, sets: 20, reps: 8, weight: 60, intensifier: { type: 'dropset', count: 10, pct: 10 } }] }
    const hundred = { id: 'h', name: 'Hundred', ex: [{ id: '0007', sets: 50, reps: 5 }, { id: '0001', sets: 50, reps: 5 }] }
    const sixty = { id: 'x', name: 'Sixty', ex: [{ id: '0007', sets: 50, reps: 5 }, { id: '0001', sets: 10, reps: 5 }] }
    useStore.setState({ S: { ...useStore.getState().S, routines: [unilateral, hundred, sixty] } })
    beginWorkout(['u'], null)
    expect(useStore.getState().S.active.entries[0].sets[0].sides.L.drops).toHaveLength(10)
    act(() => addRoutineToSessionSheet())
    const host = openTop()
    const h = rowOf(host, 'Hundred')
    expect(h.getAttribute('aria-disabled')).toBe('true')
    expect(h.querySelector('.tag').textContent).toBe('too much for this workout')
    const before = JSON.stringify(useStore.getState().S.active)
    buildSessionEntries.mockClear()
    act(() => h.click())
    expect(JSON.stringify(useStore.getState().S.active)).toBe(before)
    expect(buildSessionEntries).not.toHaveBeenCalled()
    // Sixty more brings it to exactly 500, and is added.
    expect(rowOf(host, 'Sixty').getAttribute('aria-disabled')).toBeNull()
    act(() => rowOf(host, 'Sixty').click())
    expect(useStore.getState().S.active.routineIds).toEqual(['u', 'x'])
  })
  it('still adds a routine that fits, up to the cap exactly', () => {
    // Small (3 rows) plus a 497-row routine is 500.
    const fits = { id: 'f', name: 'Fits', ex: [...Array.from({ length: 9 }, () => ({ id: '0025', sets: 50, reps: 5 })), { id: '0007', sets: 47, reps: 5 }] }
    useStore.setState({ S: { ...useStore.getState().S, routines: [small, fits] } })
    beginWorkout(['s'], null)
    act(() => addRoutineToSessionSheet())
    const host = openTop()
    act(() => rowOf(host, 'Fits').click())
    expect(useStore.getState().S.active.routineIds).toEqual(['s', 'f'])
  })
})
