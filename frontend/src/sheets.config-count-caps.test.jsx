// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { EXDB, EXIDX } from './lib/exercises.js'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exConfigSheet } from './sheets.jsx'
import { bindUI } from './components/ui.jsx'
import { MAX_WORK_SETS, MAX_DROPS, MAX_BURST_REPS, MAX_TRIPLE_SETS } from './lib/limits.js'

// NATG-503: the counts the exercise settings write stop at lib/limits.js, so the user's own
// routine is never cut down when it is trained. Each capped stepper stops its + at the limit with
// a "Max {0}" line under it, and a larger number typed is pulled back to the limit on leaving it.
const BENCH = EXDB.find(e => e.id === '0009')
const HIGH_KNEES = EXIDX['3556']
const mounted = []

function open(ex, cfg) {
  const onSave = vi.fn()
  exConfigSheet(ex, cfg, onSave)
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push([root, host])
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  const stepper = label => [...host.querySelectorAll('.stp-w')].find(w => w.querySelector('.stp-l')?.textContent === label)
  const save = () => act(() => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click())
  return { host, stepper, save, onSave }
}

const plusOf = w => w.querySelector('button[aria-label="Increase"]')
const fieldOf = w => w.querySelector('input.num')
const hintOf = w => w.querySelector('.stp-h')?.textContent
const type = (field, value) => act(() => {
  Object.getOwnPropertyDescriptor(field.constructor.prototype, 'value').set.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})
const blur = field => act(() => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))

// One below the cap: + reaches it and says so, a second + changes nothing.
function stepsToCap(v, label, cap, hint) {
  const w = v.stepper(label)
  expect(w, label).toBeTruthy()
  expect(hintOf(w)).toBe('')
  act(() => plusOf(w).click())
  expect(fieldOf(v.stepper(label)).value).toBe(String(cap))
  act(() => plusOf(v.stepper(label)).click())
  expect(fieldOf(v.stepper(label)).value).toBe(String(cap))
  expect(plusOf(v.stepper(label)).getAttribute('aria-disabled')).toBe('true')
  expect(hintOf(v.stepper(label))).toBe(hint)
}
// A number past the cap, typed: the hint shows at once, and leaving the field sets the cap.
function typedPastCap(v, label, typed, cap, hint) {
  const field = fieldOf(v.stepper(label))
  type(field, String(typed))
  expect(hintOf(v.stepper(label))).toBe(hint)
  blur(field)
  expect(fieldOf(v.stepper(label)).value).toBe(String(cap))
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  bindUI(useUI)
  useUI.setState({ sheets: [] })
  useStore.setState(s => ({ S: { ...s.S, unit: 'kg' } }))
  document.body.innerHTML = ''
})
afterEach(() => { act(() => { mounted.splice(0).forEach(([root, host]) => { root.unmount(); host.remove() }) }) })

describe('exercise settings cap their counts at lib/limits.js (NATG-503)', () => {
  it('AC1: Sets (reps) stops at 50, by + and by typing, and saves 50', () => {
    const v = open(BENCH, { sets: MAX_WORK_SETS - 1, reps: 8, weight: 60, mode: 'reps' })
    stepsToCap(v, 'Sets', MAX_WORK_SETS, 'Max 50')
    v.save()
    expect(v.onSave.mock.calls[0][0]).toMatchObject({ sets: MAX_WORK_SETS })
  })

  it('AC1: Sets (reps) typed as 80 is 50 once the field is left', () => {
    const v = open(BENCH, { sets: 3, reps: 8, weight: 60, mode: 'reps' })
    typedPastCap(v, 'Sets', 80, MAX_WORK_SETS, 'Max 50')
    v.save()
    expect(v.onSave.mock.calls[0][0]).toMatchObject({ sets: MAX_WORK_SETS })
  })

  it('AC1: Sets from, on triple progression, stops at 50', () => {
    const v = open(BENCH, { prog: 'triple', sets: MAX_WORK_SETS - 1, setsMax: 5, reps: 12, repsMin: 8, weight: 40, mode: 'reps' })
    stepsToCap(v, 'Sets from', MAX_WORK_SETS, 'Max 50')
  })

  it('AC1: Sets (time) stops at 50', () => {
    const v = open(BENCH, { sets: MAX_WORK_SETS - 1, sec: 45, weight: 0, mode: 'time' })
    stepsToCap(v, 'Sets', MAX_WORK_SETS, 'Max 50')
    typedPastCap(v, 'Sets', 75, MAX_WORK_SETS, 'Max 50')
  })

  it('AC2: Drops stops at 10, by + and by typing, and saves 10', () => {
    const v = open(BENCH, { sets: 3, reps: 8, weight: 60, mode: 'reps', intensifier: { type: 'dropset', count: MAX_DROPS - 1, pct: 20 } })
    stepsToCap(v, 'Drops', MAX_DROPS, 'Max 10')
    typedPastCap(v, 'Drops', 25, MAX_DROPS, 'Max 10')
    v.save()
    expect(v.onSave.mock.calls[0][0].intensifier).toMatchObject({ type: 'dropset', count: MAX_DROPS })
  })

  it('AC3: Rest-pause reps stops at 1,000, by + and by typing, and saves 1000', () => {
    const v = open(BENCH, { sets: 1, reps: 10, weight: 60, mode: 'reps', intensifier: { type: 'restpause', totalReps: MAX_BURST_REPS - 1, restSec: 15 } })
    stepsToCap(v, 'Rest-pause reps', MAX_BURST_REPS, 'Max 1,000')
    typedPastCap(v, 'Rest-pause reps', 5000, MAX_BURST_REPS, 'Max 1,000')
    v.save()
    expect(v.onSave.mock.calls[0][0].intensifier).toMatchObject({ type: 'restpause', totalReps: MAX_BURST_REPS })
  })

  it('AC10: cardio Intervals stops at 50, by + and by typing, and saves 50', () => {
    const v = open(HIGH_KNEES, { sets: MAX_WORK_SETS - 1, min: 2, speed: 8 })
    stepsToCap(v, 'Intervals', MAX_WORK_SETS, 'Max 50')
    typedPastCap(v, 'Intervals', 99, MAX_WORK_SETS, 'Max 50')
    v.save()
    expect(v.onSave.mock.calls[0][0]).toMatchObject({ sets: MAX_WORK_SETS })
  })

  it('AC11: Sets up to, on triple progression, stops at 10, by + and by typing, and saves 10', () => {
    const v = open(BENCH, { prog: 'triple', sets: 3, setsMax: MAX_TRIPLE_SETS - 1, reps: 12, repsMin: 8, weight: 40, mode: 'reps' })
    stepsToCap(v, 'Sets up to', MAX_TRIPLE_SETS, 'Max 10')
    typedPastCap(v, 'Sets up to', 40, MAX_TRIPLE_SETS, 'Max 10')
    v.save()
    expect(v.onSave.mock.calls[0][0]).toMatchObject({ prog: 'triple', setsMax: MAX_TRIPLE_SETS })
  })

  it('leaves the uncapped steppers beside them as they were', () => {
    const v = open(BENCH, { sets: 3, reps: 8, weight: 60, mode: 'reps' })
    expect(v.stepper('Reps').querySelector('.stp-h')).toBeNull()
    expect(v.stepper('Weight (kg)').querySelector('.stp-h')).toBeNull()
  })
})
