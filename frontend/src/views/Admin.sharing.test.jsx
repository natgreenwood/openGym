// @vitest-environment happy-dom
// NATG-485 AC1: the Admin Dashboard's "Allow Users to Share Routines" option. Off by default, the
// switch asks before it turns sharing on, and once on there is no control left to turn it off.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ config: null, calls: [], enable: null, toasts: [] }))
vi.mock('../lib/api.js', () => ({
  api: (path, opts) => {
    mocks.calls.push([path, opts])
    if (path === '/api/admin/sharing/enable') return mocks.enable()
    if (path === '/api/admin/users') return Promise.resolve({ users: [], invite_only: false })
    if (path === '/api/admin/invites') return Promise.resolve({ invites: [] })
    return Promise.reject(new Error('not found'))
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'adm', name: 'Admin', admin: true }, S: {}, refreshConfig: () => Promise.resolve(mocks.config) })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: m => mocks.toasts.push(m), openSheet: () => {} })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {}, useLocation: () => ({ state: null }) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))
vi.mock('./AdminCoach.jsx', () => ({ default: () => null }))
import { confirmSheet } from '../sheets.jsx'

let root, host
async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Admin />))
  await act(() => new Promise(r => setTimeout(r, 0)))
}
const card = () => [...host.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent === 'Routine sharing')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.calls.length = 0
  mocks.toasts.length = 0
  mocks.config = { invite_only: false }
  mocks.enable = () => Promise.resolve({ ok: true, enabled: true, enabledAt: '2026-11-03T00:00:00Z' })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Admin · Allow Users to Share Routines', () => {
  it('is off by default: an Off pill and a switch that is not on', async () => {
    await render()
    const c = card()
    expect(c.querySelector('.adm-pill').textContent).toBe('Off')
    expect(c.textContent).toContain('Nobody can share routines yet.')
    const sw = c.querySelector('[role="switch"]')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.getAttribute('aria-labelledby')).toBe('adm-share-t')
    expect(c.querySelector('#adm-share-t').textContent).toBe('Allow Users to Share Routines')
  })

  it('asks first, turns sharing on, and then shows On with no way to turn it off', async () => {
    await render()
    act(() => card().querySelector('[role="switch"]').click())
    // Nothing is sent until the admin confirms.
    expect(mocks.calls.some(([p]) => p === '/api/admin/sharing/enable')).toBe(false)
    const dialog = confirmSheet.mock.calls[0][0]
    expect(dialog.title).toBe('Turn on routine sharing?')
    expect(dialog.message).toMatch(/can’t turn this off again/)
    await act(async () => { dialog.onConfirm(); await new Promise(r => setTimeout(r, 0)) })
    expect(mocks.calls).toContainEqual(['/api/admin/sharing/enable', { method: 'POST', body: '{}' }])
    const c = card()
    expect(c.querySelector('[role="switch"]')).toBeNull()
    expect(c.querySelector('.adm-locked').textContent).toBe('On')
    expect(c.querySelector('.adm-pill').textContent).toBe('On')
    expect(c.textContent).toContain('Can’t be turned off in this version.')
  })

  it('shows On, locked, when the server already has sharing on', async () => {
    mocks.config = { shares: true }
    await render()
    const c = card()
    expect(c.querySelector('[role="switch"]')).toBeNull()
    expect(c.querySelector('.adm-locked').textContent).toBe('On')
    expect([...c.querySelectorAll('button')].map(b => b.textContent)).toEqual([])
  })

  it('stays off and says why when turning it on fails', async () => {
    mocks.enable = () => Promise.reject(new Error('cross-origin request refused'))
    await render()
    act(() => card().querySelector('[role="switch"]').click())
    await act(async () => { confirmSheet.mock.calls[0][0].onConfirm(); await new Promise(r => setTimeout(r, 0)) })
    expect(card().querySelector('[role="switch"]')).toBeTruthy()
    expect(mocks.toasts.at(-1)).toMatch(/^Could not turn on routine sharing: cross-origin request refused/)
  })

  it('says it could not check, with a retry, when the config does not load', async () => {
    mocks.config = null
    await render()
    expect(card().textContent).toContain('Could not check whether sharing is on.')
    expect(card().querySelector('[role="switch"]').disabled).toBe(true)
  })
})
