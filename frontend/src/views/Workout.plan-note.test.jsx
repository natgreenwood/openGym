// @vitest-environment happy-dom
// The plan note (a routine slot's `note`) is drawn as text on the exercise card. Older or
// hand-edited data can hold something else there, such as an object, and React cannot draw an
// object as text: the card has to come up without the note instead of failing (NATG-657).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const SQUAT = '0043'   // barbell full squat
let root, container

function mount(note) {
  if (root) unmount()
  const S = JSON.parse(JSON.stringify(DEF))
  S.active = {
    id: 'plan-note-test', d: '2026-11-10', start: Date.now(), routineId: null, name: 'Legs', bw: null, cur: 0,
    entries: [{ id: SQUAT, target: { id: SQUAT, mode: 'reps', sets: 1, reps: 5, weight: 100, note }, sets: [{ w: 100, r: 5, done: false }] }],
  }
  useStore.setState({ S, user: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}
function unmount() {
  act(() => root.unmount())
  container.remove()
  root = null
}
afterEach(() => { if (root) unmount() })

const notes = () => [...container.querySelectorAll('.exnote')].map(n => n.textContent)

describe('the plan note on the exercise card', () => {
  it('shows a text note', () => {
    mount('Pause at the bottom')
    expect(notes()).toEqual(['Pause at the bottom'])
  })

  it('leaves out a note that is an object, and the card still renders', () => {
    mount({})
    expect(container.querySelector('.setrow')).not.toBe(null)
    expect(notes()).toEqual([])
  })

  it('leaves out a note that is a number', () => {
    mount(5)
    expect(container.querySelector('.setrow')).not.toBe(null)
    expect(notes()).toEqual([])
  })
})
