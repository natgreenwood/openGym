// @vitest-environment happy-dom
// Importing a one-routine plan file toasted "Added 1 routines to your plan" (QA copy): the
// sheet's summary line already picked the singular, the toast after the merge did not.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { planImportSheet } from './sheets.jsx'
import { parsePlan } from './lib/plan-share.js'
import { EXDB } from './lib/exercises.js'

const clone = v => JSON.parse(JSON.stringify(v))
const ids = EXDB.filter(e => e.bp !== 'cardio').slice(0, 2).map(e => e.id)
const mounted = []

function renderTop() {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const buttonFor = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent === label)
const bundleOf = routines => parsePlan({ opengym_plan: 1, unit: 'kg', week: {}, routines, customEx: [] }, 'kg')
const routine = (id, name) => ({ id, name, emoji: null, ex: [{ id: ids[0], sets: 3, reps: 8, weight: 40 }] })

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toastMsg: '' })
  document.body.innerHTML = ''
  const S = clone(useStore.getState().S)
  S.routines = []
  S.week = {}
  useStore.setState({ S, user: null })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }) })

describe('Plan import sheet — the toast counts what it added', () => {
  it('says "1 routine" for a single routine', () => {
    planImportSheet(bundleOf([routine('a', 'Push')]))
    const host = renderTop()
    act(() => { buttonFor(host, 'Add to my plan').click() })
    expect(useStore.getState().S.routines).toHaveLength(1)
    expect(useUI.getState().toastMsg).toBe('Added 1 routine to your plan')
  })

  it('keeps the plural for several', () => {
    planImportSheet(bundleOf([routine('a', 'Push'), routine('b', 'Pull')]))
    const host = renderTop()
    act(() => { buttonFor(host, 'Add to my plan').click() })
    expect(useUI.getState().toastMsg).toBe('Added 2 routines to your plan')
  })
})

// NATG-503 AC4: a file with counts past lib/limits.js still imports, at the limits, and the sheet
// says so before "Add to my plan". A file within them shows no such notice.
describe('Plan import sheet — counts lowered to the limits', () => {
  const notice = host => [...host.querySelectorAll('.shared-notice.warn')].find(n => n.textContent.includes('Some counts were lowered'))
  const over = (id, name) => ({ id, name, emoji: null, ex: [
    { id: ids[0], sets: 80, reps: 8, weight: 40 },
    { id: ids[1], sets: 3, reps: 8, weight: 40, intensifier: { type: 'dropset', count: 25, pct: 20 } },
  ] })

  it('AC4: says how many exercises were lowered, with the limits, and still imports them at the limits', () => {
    planImportSheet(bundleOf([over('a', 'Push')]))
    const host = renderTop()
    const n = notice(host)
    expect(n).toBeTruthy()
    expect(n.getAttribute('role')).toBe('status')
    expect(n.textContent).toContain('2 exercises had more than the app allows. They’ll be added with at most 50 sets or intervals, 10 drops and 1,000 rest-pause reps.')
    act(() => { buttonFor(host, 'Add to my plan').click() })
    const [a, b] = useStore.getState().S.routines[0].ex
    expect(a.sets).toBe(50)
    expect(b.intensifier.count).toBe(10)
    expect(useUI.getState().toastMsg).toBe('Added 1 routine to your plan')
  })

  it('AC4: uses the singular for one exercise', () => {
    planImportSheet(bundleOf([{ id: 'a', name: 'Push', emoji: null, ex: [{ id: ids[0], sets: 80, reps: 8, weight: 40 }] }]))
    const host = renderTop()
    expect(notice(host).textContent).toContain('1 exercise had more than the app allows. It’ll be added with at most 50 sets')
  })

  it('AC4: shows no notice when nothing was lowered', () => {
    planImportSheet(bundleOf([routine('a', 'Push')]))
    const host = renderTop()
    expect(notice(host)).toBeUndefined()
    expect(host.textContent).not.toContain('Some counts were lowered')
  })
})
