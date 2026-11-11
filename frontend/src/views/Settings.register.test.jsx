// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* "Create passkey profile" in Settings on a guest copy with data (NATG-665), the same registration
   as the sign-in screen's. The copy has no base for the new profile, so its push pulls first and
   only then sends: the toast says the data moved in only once push and pull have both settled and
   nothing is owed any more. Until then it says the move is under way. */
const mocks = vi.hoisted(() => {
  // `kept` is one array for good: KeptChangesRows re-asks whenever the function changes, and a
  // fresh [] per answer would re-render it forever.
  const state = { S: null, hasData: true, owed: false, sheets: [], kept: [] }
  state.toast = vi.fn()
  state.setUser = vi.fn()
  state.pushState = vi.fn()
  state.pullState = vi.fn()
  state.passkeyRegister = vi.fn(async name => ({ id: 'u9', name }))
  state.snapshot = () => ({
    S: state.S, user: null, sync: null, config: null, coachLocal: null,
    update: vi.fn(), replaceState: vi.fn(), setUser: state.setUser, pullState: state.pullState, pushState: state.pushState, resetDemo: vi.fn(),
    syncNow: vi.fn(), unsyncedChanges: () => ({ owed: state.owed, count: state.owed ? 1 : 0 }), keptChanges: async () => state.kept,
    disconnectServer: vi.fn(), signOut: vi.fn(), signOutAll: vi.fn(), adoptProfile: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => mocks.hasData }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: (render, opts) => { mocks.sheets.push({ render, opts }); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async () => ({})), webauthnOK: () => true, passkeyLogin: vi.fn(), passkeyRegister: (...a) => mocks.passkeyRegister(...a),
  passkeyError: (e, m) => m, IS_ANDROID: false,
  passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(), askAddDeviceData: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

const PENDING = 'Profile created. Moving this device’s data into it…'
const LANDED = 'Profile created, and this device’s data moved into it'
const KEPT = 'Profile created. This device’s data is kept here and moves into it at the next sync.'

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const section = (page, title) => [...page.querySelectorAll('.sect')].find(s => s.querySelector('.sect-t')?.textContent === title)
const rowByTitle = (el, title) => [...el.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Opens "Create passkey profile", names it and confirms; the sheet closes before the toasts.
async function register(name = 'Cleo') {
  const close = vi.fn()
  const page = mount(<Settings page="account" />)
  act(() => rowByTitle(section(page, 'Account'), 'Create passkey profile').click())
  const sheet = mount(mocks.sheets.at(-1).render(close))
  await settle()
  sheet.querySelector('input[placeholder="Your name"]').value = name
  act(() => button(sheet, 'Create passkey').click())
  await settle()
  return close
}

beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none', gifSize: 'full', workouts: [], routines: [], exWeights: {} }
  mocks.hasData = true
  mocks.owed = false
  mocks.sheets.length = 0
  for (const f of [mocks.toast, mocks.setUser, mocks.passkeyRegister]) f.mockClear()
  mocks.pushState.mockReset()
  mocks.pullState.mockReset()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Settings: creating a profile on a guest copy with data', () => {
  it.each([
    [false, LANDED],
    [true, KEPT],
  ])('says the move is under way, and only after push and pull have settled (owed %s) says how it went', async (owed, result) => {
    mocks.owed = owed
    const push = deferred(), pull = deferred()
    mocks.pushState.mockReturnValue(push.promise)
    mocks.pullState.mockReturnValue(pull.promise)
    const close = await register()
    expect(mocks.passkeyRegister).toHaveBeenCalledWith('Cleo', '')
    expect(mocks.setUser).toHaveBeenCalledWith({ id: 'u9', name: 'Cleo' })
    expect(close).toHaveBeenCalled()
    expect(mocks.toast.mock.calls).toEqual([[PENDING, { ms: 90000 }]])

    await act(async () => push.resolve())
    await settle()
    expect(mocks.pullState).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledTimes(1)

    await act(async () => pull.resolve())
    await settle()
    expect(mocks.toast).toHaveBeenCalledTimes(2)
    // The result has no action: the sync bar already offers a retry when a pull fails.
    expect(mocks.toast.mock.lastCall).toEqual([result])
  })

  it('a guest copy without data still pulls and says welcome, with no pending toast', async () => {
    mocks.hasData = false
    mocks.pullState.mockResolvedValue()
    await register()
    expect(mocks.pushState).not.toHaveBeenCalled()
    expect(mocks.toast.mock.calls).toEqual([['Welcome, Cleo']])
  })
})
