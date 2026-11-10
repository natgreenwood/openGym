// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { EXDB } from './lib/exercises.js'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exConfigSheet } from './sheets.jsx'

// A slot's note is free text, but an older or hand-edited routine can hold anything there. A note
// that isn't a string used to throw on Save (`5.trim` is not a function) after the sheet had
// already closed, so the edit was lost and that exercise's settings could not be changed at all.
// Such a note is dropped, not converted: `{}` would otherwise read "[object Object]".
const ex = EXDB.find(e => e.id === '0009')
const mounted = []

function renderConfig(cfg) {
  const onSave = vi.fn()
  exConfigSheet(ex, { sets: 4, reps: 8, weight: 40, mode: 'reps', restSec: 75, ...cfg }, onSave)
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return { host, onSave }
}
function type(el, value) {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const save = host => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()

describe('exercise settings: the note', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useUI.setState({ sheets: [] })
    useStore.setState(s => ({ S: { ...s.S, unit: 'kg' } }))
    document.body.innerHTML = ''
  })
  afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

  it.each([['a number', 5], ['an object', {}]])('saves the rest of the edit and drops a note that is %s', (_, note) => {
    const { host, onSave } = renderConfig({ note })
    act(() => save(host))
    expect(onSave).toHaveBeenCalledTimes(1)
    const out = onSave.mock.calls[0][0]
    expect(out).toMatchObject({ sets: 4, reps: 8, weight: 40, restSec: 75 })
    expect('note' in out).toBe(false)
  })

  it('shows an empty note for one that is not a string, and saves what is typed over it', () => {
    const { host, onSave } = renderConfig({ note: {} })
    expect(host.querySelector('textarea').value).toBe('')
    act(() => type(host.querySelector('textarea'), 'bar only'))
    act(() => save(host))
    expect(onSave.mock.calls[0][0].note).toBe('bar only')
  })

  it('still saves a string note trimmed and capped at 500 characters', () => {
    const { host, onSave } = renderConfig({ note: `  ${'a'.repeat(600)}  ` })
    act(() => save(host))
    expect(onSave.mock.calls[0][0].note).toBe('a'.repeat(500))

    const { host: host2, onSave: onSave2 } = renderConfig({ note: '  bar only, +1 plate/side each set ' })
    expect(host2.querySelector('textarea').value).toBe('  bar only, +1 plate/side each set ')
    act(() => save(host2))
    expect(onSave2.mock.calls[0][0].note).toBe('bar only, +1 plate/side each set')
  })
})
