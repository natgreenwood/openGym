// @vitest-environment happy-dom
// The toast's action button (NATG-670): Undo keeps its arrow, and an action that names no icon
// (the routine page's "Show") is its label alone.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useUI } from '../store/useUI.js'
import Toast from './Toast.jsx'

let host, root
beforeEach(() => {
  vi.useFakeTimers()
  useUI.setState({ toastMsg: '', toastAction: null })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root.render(<Toast />))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers() })
const button = () => host.querySelector('.toast-act')

it('an Undo carries its arrow, as every Undo did before', () => {
  act(() => useUI.getState().toast('Set 2 gone.', { action: 'Undo', onAction: () => {} }))
  expect(button().textContent).toBe('Undo')
  expect(button().querySelector('.icn')).not.toBeNull()
})

it('an action with `icon: null` shows its label and no icon', () => {
  const onAction = vi.fn()
  act(() => useUI.getState().toast('This routine is now too large to share.', { action: 'Show', onAction, icon: null }))
  expect(button().textContent).toBe('Show')
  expect(button().querySelector('.icn, svg')).toBeNull()
  act(() => button().click())
  expect(onAction).toHaveBeenCalledTimes(1)
})
