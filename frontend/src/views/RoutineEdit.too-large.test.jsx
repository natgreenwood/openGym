// @vitest-environment happy-dom
// NATG-670: the routine page tells a sharer when their shared routine is too large to share. One
// notice in the Sharing section, by this device's measure or the server's flag on the outgoing
// share (only the device's own while an edit is unsettled), and a toast with "Show" when an edit
// made here takes the routine over the cap.
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
import { sharedBytes, MAX_SHARED_BYTES } from '../../../api/shared-measure.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host

const ME = { id: 'u1', name: 'Sam Keller' }
const out = (id, name, extra = {}) => ({ id, to: { id: 'p' + id, name }, routineId: 'r1', created: '2026-11-03T00:00:00Z', ...extra })
const SLOT = { id: '0025', sets: 3, mode: 'reps', reps: 5, weight: 80 }
// A routine whose projection is exactly `bytes` UTF-8 bytes, padded in a note of two-byte letters.
function routineOf(bytes) {
  const r = { id: 'r1', name: 'Push Day', emoji: 'dumbbell', ex: [{ ...SLOT, note: '' }] }
  const need = bytes - sharedBytes(r, Infinity)
  r.ex[0].note = 'ü'.repeat(Math.floor(need / 2)) + 'a'.repeat(need % 2)
  expect(sharedBytes(r, Infinity)).toBe(bytes)
  return r
}
const UNDER = MAX_SHARED_BYTES - 10
const OVER = MAX_SHARED_BYTES + 10

async function mount({ routine = routineOf(1000), outgoing = [out('s1', 'Alex Rivera')], unsettled = false } = {}) {
  answers.shares = { incoming: [], outgoing, etag: 'e' }
  const S = JSON.parse(JSON.stringify(DEF))
  S.routines = [routine]
  localStorage.setItem('gym_owner', ME.id)
  useStore.setState({ S, user: ME, config: { shares: true }, shares: null, sharesError: false, sync: { ...useStore.getState().sync, unsettled } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<MemoryRouter initialEntries={['/plan/r/r1']}><Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /></Routes></MemoryRouter>))
  await act(() => new Promise(r => setTimeout(r, 0)))
}
const notice = () => host.querySelector('.share-too-large')
// An edit on this page, as the slot's note field makes one: through the store's update().
const editNote = note => act(() => useStore.getState().update(s => { s.routines[0].ex[0].note = note }))
const noteOf = bytes => routineOf(bytes).ex[0].note
// The same change arriving from elsewhere (a pull, another tab): a new copy put in place directly.
const pulled = note => act(() => {
  const S = JSON.parse(JSON.stringify(useStore.getState().S))
  S.routines[0].ex[0].note = note
  useStore.setState({ S })
})
const toastShown = () => useUI.getState().toastMsg === 'This routine is now too large to share.'

beforeEach(() => {
  vi.resetAllMocks()
  useUI.setState({ sheets: [], toastMsg: '', toastAction: null })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('when the notice shows (AC2, AC4)', () => {
  it('a shared routine at exactly the cap shows nothing; one byte over shows the notice', async () => {
    await mount({ routine: routineOf(MAX_SHARED_BYTES) })
    expect(notice()).toBeNull()
    act(() => root.unmount()); host.remove()
    await mount({ routine: routineOf(MAX_SHARED_BYTES + 1) })
    expect(notice()).not.toBeNull()
    expect(notice().textContent).toBe('People you’ve shared this with won’t be able to open it'
      + 'It’s too large for a shared routine. Shorten its exercise notes or remove some exercises, and they’ll be able to open it.')
  })

  it('a routine shared with nobody shows nothing, however large', async () => {
    await mount({ routine: routineOf(OVER), outgoing: [] })
    expect(notice()).toBeNull()
  })

  it('shows the server’s flag for a routine this device measures under the cap (a save from elsewhere)', async () => {
    await mount({ routine: routineOf(UNDER), outgoing: [out('s1', 'Alex Rivera', { unavailable: 'too-large' })] })
    expect(notice()).not.toBeNull()
  })

  it('while an edit is unsettled, goes by this device’s measure alone', async () => {
    await mount({ routine: routineOf(UNDER), outgoing: [out('s1', 'Alex Rivera', { unavailable: 'too-large' })], unsettled: true })
    expect(notice()).toBeNull()
  })
})

describe('as edits come and go (AC3)', () => {
  it('appears with the edit that takes it over, and goes with the edit that brings it back, the server’s old flag notwithstanding', async () => {
    await mount({ routine: routineOf(UNDER) })
    editNote(noteOf(OVER))
    expect(notice()).not.toBeNull()
    // The lists answer with the verdict on that copy: still over, by the server's word too.
    act(() => useStore.setState({ shares: { ...useStore.getState().shares, outgoing: [out('s1', 'Alex Rivera', { unavailable: 'too-large' })] } }))
    editNote(noteOf(UNDER))
    expect(useStore.getState().sync.unsettled).toBe(true)
    expect(notice()).toBeNull()
    expect(host.textContent).not.toMatch(/working again|can open it again/i)
  })
})

describe('what it says (AC5)', () => {
  it('names and counts nobody, and reads the same for one person as for three', async () => {
    await mount({ routine: routineOf(OVER) })
    const one = notice().textContent
    act(() => root.unmount()); host.remove()
    await mount({ routine: routineOf(OVER), outgoing: [out('s1', 'Alex Rivera'), out('s2', 'Bo Chen'), out('s3', 'Cy Diaz')] })
    expect(notice().textContent).toBe(one)
    for (const name of ['Alex', 'Bo', 'Cy', '3', 'three']) expect(notice().textContent).not.toContain(name)
  })
})

describe('the toast (AC6)', () => {
  it('an edit here that crosses the cap raises it once, with a Show that has no icon', async () => {
    await mount({ routine: routineOf(UNDER) })
    editNote(noteOf(OVER))
    expect(toastShown()).toBe(true)
    expect(useUI.getState().toastAction).toMatchObject({ label: 'Show', icon: null })
    act(() => useUI.getState().dismissToast())
    editNote(noteOf(OVER + 5))   // still over: no second toast
    expect(toastShown()).toBe(false)
  })

  it('is not raised on opening a page already over the cap', async () => {
    await mount({ routine: routineOf(OVER) })
    expect(notice()).not.toBeNull()
    expect(toastShown()).toBe(false)
  })

  it('is not raised on opening the page right after an edit elsewhere took it over', async () => {
    // The lists are already kept on this device, and the copy in place is one an edit made.
    const S = JSON.parse(JSON.stringify(DEF))
    S.routines = [routineOf(OVER)]
    useStore.setState({ S, user: ME, config: { shares: true }, shares: { uid: ME.id, outgoing: [out('s1', 'Alex Rivera')], incoming: [], etag: 'e' } })
    act(() => useStore.getState().update(s => { s.routines[0].name = 'Push Day 2' }))
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    act(() => root.render(<MemoryRouter initialEntries={['/plan/r/r1']}><Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /></Routes></MemoryRouter>))
    expect(notice()).not.toBeNull()
    expect(toastShown()).toBe(false)
  })

  it('is not raised when the crossing comes from a sync, though the notice shows', async () => {
    await mount({ routine: routineOf(UNDER) })
    pulled(noteOf(OVER))
    expect(notice()).not.toBeNull()
    expect(toastShown()).toBe(false)
  })

  it('is raised again on a second crossing after the routine went back under', async () => {
    await mount({ routine: routineOf(UNDER) })
    editNote(noteOf(OVER))
    act(() => useUI.getState().dismissToast())
    editNote(noteOf(UNDER))
    expect(toastShown()).toBe(false)
    editNote(noteOf(OVER))
    expect(toastShown()).toBe(true)
  })

  it('is not raised for a routine that isn’t shared', async () => {
    await mount({ routine: routineOf(UNDER), outgoing: [] })
    editNote(noteOf(OVER))
    expect(toastShown()).toBe(false)
  })

  it('Show scrolls the notice to the top smoothly and focuses it without a second scroll', async () => {
    vi.stubGlobal('matchMedia', q => ({ matches: false, media: q }))
    await mount({ routine: routineOf(UNDER) })
    editNote(noteOf(OVER))
    const scroll = vi.spyOn(notice(), 'scrollIntoView').mockImplementation(() => {})
    const focus = vi.spyOn(notice(), 'focus')
    act(() => useUI.getState().runToastAction())
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(notice())
  })

  it('Show jumps without animation under reduced motion', async () => {
    vi.stubGlobal('matchMedia', q => ({ matches: q.includes('reduce'), media: q }))
    await mount({ routine: routineOf(UNDER) })
    editNote(noteOf(OVER))
    const scroll = vi.spyOn(notice(), 'scrollIntoView').mockImplementation(() => {})
    act(() => useUI.getState().runToastAction())
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
  })
})

describe('accessibility (AC7)', () => {
  it('the notice is no live region, takes focus only from script, hides its icon, and describes the share row', async () => {
    await mount({ routine: routineOf(OVER) })
    const n = notice()
    expect(n.getAttribute('role')).toBeNull()
    expect(n.getAttribute('aria-live')).toBeNull()
    expect(n.getAttribute('tabindex')).toBe('-1')
    expect(n.querySelector('svg').getAttribute('aria-hidden')).toBe('true')
    const row = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Share with more people')
    expect(row.getAttribute('aria-describedby')).toBe(n.id)
    // Placed first in the Sharing section, above the share row.
    expect(n.previousElementSibling.textContent).toBe('Sharing')
  })

  it('the share row describes nothing extra while the routine is under the cap', async () => {
    await mount({ routine: routineOf(UNDER) })
    const row = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Share with more people')
    expect(row.hasAttribute('aria-describedby')).toBe(false)
  })
})
