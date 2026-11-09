// @vitest-environment happy-dom

/* NATG-581 SEC-581-01 (found by Security, reproduced by QA). A sign-out held to the account that
   clicked it was still lost through the owed sheet: each "Try again" or "Sign out anyway" was a new
   call that took whoever owned the browser by then. A "Try again" waiting on its sync while another
   tab signed Test B in, the sheet unmounted by the handover, came back as Test B's own sign-out
   and signed Test B out (everywhere, too). The account is now taken once, at the click
   (leaveServer), and every attempt of that sign-out is held to it. Real stores, real useUI, and
   the sheet as rendered. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const h = vi.hoisted(() => ({ api: null }))
vi.mock('../lib/api.js', () => ({ api: (...args) => h.api(...args), setRemoteAuth: vi.fn(), passkeyLogin: vi.fn(), webauthnOK: () => true }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), menuSheet: vi.fn() }))
vi.mock('../views/MobileOnboarding.jsx', () => ({ ConnectSheet: () => null, CfAccessSheet: () => null }))

let useStore, otherTab, useUI, leaveServer, host, root, net
const first = { id: 'test-account-a', name: 'Test A' }
const second = { id: 'test-account-b', name: 'Test B' }
// The other tab signs Test B in and finishes adopting its profile; `hear` delivers this tab's
// storage events for it, as the browser would.
const secondSignsIn = async hear => {
  otherTab.getState().setUser(second, { adopt: true })
  if (hear) window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: first.id, newValue: second.id }))
  await otherTab.getState().adoptProfile(async () => false)
  if (!hear) return
  window.dispatchEvent(new StorageEvent('storage', { key: 'gym_state_wid', newValue: localStorage.getItem('gym_state_wid') }))
  window.dispatchEvent(new StorageEvent('storage', { key: 'gym_sync', newValue: localStorage.getItem('gym_sync') }))
}
const gate = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

beforeEach(async () => {
  localStorage.clear()
  localStorage.setItem('gym_owner', first.id)
  localStorage.setItem('gym_owner_name', first.name)
  vi.resetModules()
  const mod = await import('../store/useStore.js')
  useStore = mod.useStore
  ;({ useUI } = await import('../store/useUI.js'))
  ;({ leaveServer } = await import('./ServerSync.jsx'))
  net = { state: { ...structuredClone(mod.DEF), _ts: 100 }, rev: 1, fail: false, hold: false, asked: gate(), release: gate(), logouts: [] }
  h.api = async (path, opts = {}) => {
    if (path === '/api/data/rev') return { rev: net.rev }
    if (path === '/api/data' && opts.method === 'PUT') {
      if (net.fail) throw Object.assign(new Error('synthetic-offline'), { status: 503 })
      net.state = JSON.parse(opts.body).state
      return { ok: true, rev: ++net.rev }
    }
    if (path === '/api/data') {
      const answer = structuredClone({ state: net.state, rev: net.rev })
      if (net.hold) { net.hold = false; net.asked.resolve(); await net.release.promise }
      return answer
    }
    if (path.startsWith('/api/logout')) { net.logouts.push({ path, owner: localStorage.getItem('gym_owner') }); return { ok: true } }
    return {}
  }
  useStore.setState({ S: structuredClone(mod.DEF), user: first, ready: true })
  await useStore.getState().pullState()
  otherTab = (await import('../store/useStore.js?qa-second-tab')).useStore
  otherTab.setState({ user: first, ready: true })
  function Sheets() {
    const sheets = useUI(s => s.sheets)
    return sheets.map(s => <div key={s.id}>{s.render(() => useUI.getState().closeSheet(s.id))}</div>)
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Sheets />))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  useStore?.setState({ user: null, ready: false })
  otherTab?.setState({ user: null, ready: false })
  useUI?.getState().dismissToast()
  localStorage.clear()
})

it.each(['signout', 'everywhere'])('%s retry awaiting sync must not log out the replacement account after its sheet unmounts', async kind => {
  net.fail = true
  useStore.getState().update(s => { s.restSec = 91 })
  const completed = gate()
  const done = vi.fn(result => completed.resolve(result))
  await act(async () => { await leaveServer(kind, { exportBackup: vi.fn(), done }) })
  expect(host.textContent).toContain('Not everything is on your server yet')

  net.hold = true
  await act(async () => {
    ;[...host.querySelectorAll('button')].find(b => b.textContent === 'Try again').click()
    await net.asked.promise
  })

  net.fail = false
  net.rev = 5
  net.state = { ...net.state, _ts: 200, restSec: 75 }
  await act(async () => { await secondSignsIn(true) })
  expect(useStore.getState().user?.id).toBe(second.id)
  expect(host.querySelector('h3')).toBeNull()
  expect(net.logouts).toEqual([])

  await act(async () => { net.release.resolve(); await completed.promise })
  expect(net.logouts).toEqual([])
  expect(localStorage.getItem('gym_owner')).toBe(second.id)
  expect(done).toHaveBeenCalledTimes(1)
  expect(done).toHaveBeenCalledWith({ cancelled: true })
})

// "Sign out anyway" calls the store at once, so its gap is a click while this tab has not yet heard
// that the other tab signed Test B in: the sheet is still open, and the owner key already Test B's.
it.each(['signout', 'everywhere'])('%s "Sign out anyway" clicked after the other tab signed in, before this tab heard: cancelled', async kind => {
  net.fail = true
  useStore.getState().update(s => { s.restSec = 91 })
  const completed = gate()
  const done = vi.fn(result => completed.resolve(result))
  await act(async () => { await leaveServer(kind, { exportBackup: vi.fn(), done }) })
  expect(host.textContent).toContain('Not everything is on your server yet')

  net.fail = false
  net.rev = 5
  net.state = { ...net.state, _ts: 200, restSec: 75 }
  await act(async () => { await secondSignsIn(false) })
  expect(localStorage.getItem('gym_owner')).toBe(second.id)
  expect(useStore.getState().user?.id).toBe(first.id)   // not heard of yet
  expect(host.querySelector('h3')).not.toBeNull()

  await act(async () => {
    ;[...host.querySelectorAll('button')].find(b => b.textContent === 'Sign out anyway').click()
    await completed.promise
  })
  expect(net.logouts).toEqual([])
  expect(localStorage.getItem('gym_owner')).toBe(second.id)
  expect(useStore.getState().user?.id).toBe(second.id)   // handed over, and following Test B
  expect(host.querySelector('h3')).toBeNull()
  expect(done).toHaveBeenCalledTimes(1)
  expect(done).toHaveBeenCalledWith({ cancelled: true })
})
