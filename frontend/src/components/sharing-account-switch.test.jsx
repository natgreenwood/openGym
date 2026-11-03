// @vitest-environment happy-dom
// SEC-01 (NATG-485): a sheet opened by one account must not outlive it. A's share picker kept A's
// routine name and who already had it, and A's unshare confirm kept its recipient and a live
// callback, on screen over the sign-in and into the next account. With the real modal host and
// the real stores: open each of them as A, switch A → signed out → B through setUser and through
// another tab (the `storage` event), and nothing of A's is left, nor can it fire later.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ recipients: [], deletes: [] }))
vi.mock('../lib/api.js', async orig => ({
  ...(await orig()),
  api: vi.fn((path, opts) => {
    // setUser asks for the config again (it has no `coach` key yet): sharing stays on.
    if (path === '/api/config') return Promise.resolve({ shares: true })
    if (path === '/api/shares') return Promise.resolve({ incoming: [], outgoing: [{ id: 's1', to: { id: 'uJ', name: 'Jo Patel' }, routineId: 'r1' }], etag: 'e' })
    // Held until the test answers, as on a slow link.
    if (path === '/api/shares/recipients') return new Promise(resolve => net.recipients.push(resolve))
    if (opts?.method === 'DELETE') { net.deletes.push(path); return Promise.resolve({ ok: true }) }
    return Promise.resolve({})
  })
}))

import Modals from './Modals.jsx'
import RoutineSharing, { useRoutineShares } from './RoutineSharing.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const A = { id: 'uA', name: 'Alexa' }
const B = { id: 'uB', name: 'Sami' }
const ROUTINE = 'Alexa’s secret split'
const PEOPLE = { users: [{ id: 'uJ', name: 'Jo Patel' }, { id: 'uK', name: 'Kim Lee' }] }
let root, host

function Page() {
  const S = useStore(s => s.S)
  const shares = useRoutineShares('r1')
  const r = S.routines.find(x => x.id === 'r1')
  return <>{r && <RoutineSharing routine={r} S={S} shares={shares} />}<Modals /></>
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const modal = () => document.getElementById('modal-root')?.textContent || ''

async function signInAsA() {
  const S = JSON.parse(JSON.stringify(DEF))
  S.routines = [{ id: 'r1', name: ROUTINE, ex: [{ id: '0025', sets: 3 }] }]
  useStore.setState({ S, config: { shares: true } })
  act(() => useStore.getState().setUser(A))
  await settle()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Page />))
  await settle()
}
// The two ways the account leaves this tab: here, and in another tab of the same browser.
const SWITCHES = {
  setUser: () => {
    act(() => useStore.getState().setUser(null))
    act(() => useStore.getState().setUser(B))
  },
  'storage event': () => {
    // Another tab signed A out and B in: the owner key moved under this tab.
    localStorage.setItem('gym_owner', B.id)
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner' })) })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  net.recipients = []
  net.deletes = []
  useUI.setState({ sheets: [] })
  useStore.setState({ user: null, shares: null, sharesError: false })
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = host = null; document.body.innerHTML = '' })

describe.each(Object.keys(SWITCHES))('SEC-01: an account change through %s', how => {
  it('closes A’s share picker, and a recipients answer that lands later shows nothing', async () => {
    await signInAsA()
    act(() => button('Share with more people').click())
    expect(modal()).toContain('Share ' + ROUTINE)
    expect(net.recipients).toHaveLength(1)    // still pending
    SWITCHES[how]()
    expect(useUI.getState().sheets).toEqual([])
    expect(document.getElementById('modal-root')).toBeNull()
    // A's answer arrives after the switch.
    await act(async () => { net.recipients[0](PEOPLE); await new Promise(r => setTimeout(r, 0)) })
    expect(document.body.textContent).not.toContain('Share ' + ROUTINE)
    expect(document.body.textContent).not.toContain('Already shared')
    expect(document.body.textContent).not.toContain('Kim Lee')
  })

  it('closes A’s picker once it shows who already has the routine', async () => {
    await signInAsA()
    act(() => button('Share with more people').click())
    await act(async () => { net.recipients[0](PEOPLE); await new Promise(r => setTimeout(r, 0)) })
    expect(modal()).toContain('Already shared')
    SWITCHES[how]()
    expect(document.getElementById('modal-root')).toBeNull()
    expect(document.body.textContent).not.toContain('Already shared')
  })

  it('closes A’s unshare confirm, so its callback can never run for B', async () => {
    await signInAsA()
    act(() => document.querySelector('[aria-label="Unshare with Jo Patel"]').click())
    expect(modal()).toContain('Stop sharing with Jo Patel?')
    SWITCHES[how]()
    expect(document.getElementById('modal-root')).toBeNull()
    expect(document.body.textContent).not.toContain('Stop sharing with Jo Patel?')
    expect(button('Unshare')).toBeUndefined()
    await settle()
    expect(net.deletes).toEqual([])
  })

  it('drops a toast and its Undo, which would act on A’s copy', async () => {
    await signInAsA()
    const undo = vi.fn()
    act(() => useUI.getState().toast('Stopped sharing with Jo Patel.', { action: 'Undo', onAction: undo }))
    SWITCHES[how]()
    expect(useUI.getState().toastMsg).toBe('')
    expect(useUI.getState().toastAction).toBeNull()
    expect(undo).not.toHaveBeenCalled()
  })
})

describe('SEC-01: what is not an account change', () => {
  it('keeps the sheets open when the same account is set again (boot re-reading /api/me)', async () => {
    await signInAsA()
    act(() => button('Share with more people').click())
    act(() => useStore.getState().setUser({ ...A }))
    expect(useUI.getState().sheets).toHaveLength(1)
  })

  it('keeps a guest’s sheets open when the guest signs in', () => {
    useUI.getState().openSheet(() => <div>guest sheet</div>)
    act(() => useStore.getState().setUser(A))
    expect(useUI.getState().sheets).toHaveLength(1)
  })
})
