// @vitest-environment happy-dom
// NATG-592: the import sheets' warning and unit lines were plain text in --yellow, 1.35:1 on the
// light sheet. They are notices now: plan import's "left out" is a titled warning, the three unit
// lines are plain info notices. a11y-contrast-transparency.test.js measures the notice's colours.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { importFromApp, importFromHevy, planImportSheet } from './sheets.jsx'
import { parsePlan } from './lib/plan-share.js'
import { EXDB } from './lib/exercises.js'

const hevy = vi.hoisted(() => ({ payload: null }))
vi.mock('./lib/import-hevy.js', async orig => ({ ...(await orig()), importHevyData: vi.fn(() => Promise.resolve(hevy.payload)) }))

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
const notices = host => [...host.querySelectorAll('.shared-notice')]
const iconOf = n => n.querySelector(':scope > .icn')
// No line on these sheets keeps the yellow text it had (AC7).
const yellowText = host => [...host.querySelectorAll('[style]')].filter(el => /color:\s*var\(--yellow\)/.test(el.getAttribute('style')))

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toasts: [], toastMsg: '' })
  document.body.innerHTML = ''
  const S = clone(useStore.getState().S)
  S.unit = 'kg'
  S.routines = []
  S.week = {}
  S.workouts = []
  S.bodyweight = []
  useStore.setState({ S, user: null })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }) })

describe('plan import — exercises left out', () => {
  const bundleOf = ex => parsePlan({ opengym_plan: 1, unit: 'kg', week: {}, customEx: [],
    routines: [{ id: 'a', name: 'Push', emoji: null, ex }] }, 'kg')
  const slot = id => ({ id, sets: 3, reps: 8, weight: 40 })

  it('is a titled warning notice, singular and plural body unchanged', () => {
    planImportSheet(bundleOf([slot(ids[0]), slot('no-such-exercise')]))
    let host = renderTop()
    let [n] = notices(host)
    expect(notices(host)).toHaveLength(1)
    expect(n.classList.contains('warn')).toBe(true)
    expect(n.getAttribute('role')).toBe('status')
    expect(iconOf(n)).toBeTruthy()
    expect(n.querySelector('b').textContent).toBe('Some exercises were left out')
    expect(n.querySelector('span').textContent).toBe('1 exercise in the file isn’t in your library and was left out.')
    expect(yellowText(host)).toEqual([])

    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
    useUI.setState({ sheets: [] })
    planImportSheet(bundleOf([slot(ids[0]), slot('gone-1'), slot('gone-2')]))
    host = renderTop();
    [n] = notices(host)
    expect(n.querySelector('span').textContent).toBe('2 exercises in the file aren’t in your library and were left out.')
  })

  it('is not there when nothing was left out', () => {
    planImportSheet(bundleOf([slot(ids[0]), slot(ids[1])]))
    const host = renderTop()
    expect(notices(host)).toEqual([])
    expect(host.textContent).not.toContain('left out')
  })
})

describe('workout import — unit notes', () => {
  async function summaryFor(text) {
    importFromApp(new File([text], 'export.csv', { type: 'text/csv' }))
    for (let i = 0; i < 50 && !useUI.getState().sheets.length; i++) await new Promise(r => setTimeout(r, 5))
    return renderTop()
  }
  const infoNotice = host => {
    const all = notices(host)
    expect(all).toHaveLength(1)
    const [n] = all
    expect(n.classList.contains('warn')).toBe(false)
    expect(n.getAttribute('role')).toBe('status')
    expect(iconOf(n)).toBeTruthy()
    expect(n.querySelector('b')).toBeNull()
    expect(yellowText(host)).toEqual([])
    return n.querySelector('span').textContent
  }

  it('says weights get converted when the file is in the other unit', async () => {
    const host = await summaryFor(['Date,Exercise,Weight,Reps,Weight Unit', '2026-01-02,Bench Press,135,5,lb'].join('\n'))
    expect(infoNotice(host)).toBe('The file is in lb and your profile is in kg, so weights get converted.')
  })

  it('says each set is converted when the file mixes units', async () => {
    const host = await summaryFor(['Date,Exercise,Weight,Reps,Weight Unit', '2026-01-02,Bench Press,135,5,lb', '2026-01-03,Bench Press,60,5,kg'].join('\n'))
    expect(infoNotice(host)).toBe('The file mixes kg and lb, so each set is converted to kg.')
  })

  it('has no unit note when the file matches the profile', async () => {
    const host = await summaryFor(['Date,Exercise,Weight,Reps,Weight Unit', '2026-01-02,Bench Press,60,5,kg'].join('\n'))
    expect(notices(host)).toEqual([])
  })
})

describe('Hevy import — unit note', () => {
  const type = (input, v) => act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  async function fetched(converted) {
    hevy.payload = {
      workouts: { workouts: [], unmatchedNames: [], matchedIds: [], customEx: [], converted },
      routines: { routines: [], unmatchedNames: [], matchedIds: [], customEx: [], converted },
      bodyweight: { bodyweight: [{ d: '2026-01-02', w: 80 }] },
    }
    importFromHevy()
    const host = renderTop()
    type(host.querySelector('input[type="password"]'), 'key')
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Fetch from Hevy').click() })
    return host
  }

  it('is a plain info notice when weights get converted', async () => {
    useStore.setState(s => ({ S: { ...s.S, unit: 'lb' } }))
    const host = await fetched(true)
    const [n] = notices(host)
    expect(notices(host)).toHaveLength(1)
    expect(n.classList.contains('warn')).toBe(false)
    expect(n.getAttribute('role')).toBe('status')
    expect(iconOf(n)).toBeTruthy()
    expect(n.querySelector('b')).toBeNull()
    expect(n.querySelector('span').textContent).toBe('Hevy stores weights in kg, so they’ll be converted to lb.')
    expect(yellowText(host)).toEqual([])
  })

  it('is not there when nothing is converted', async () => {
    const host = await fetched(false)
    expect(host.textContent).toContain('Import weigh-ins')
    expect(notices(host)).toEqual([])
  })
})
