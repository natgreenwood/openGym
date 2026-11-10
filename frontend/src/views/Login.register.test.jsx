// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Creating a profile from the sign-in screen on a guest copy with data (NATG-665). The copy has no
   base for the new profile, so its push pulls first and only then sends: the toast says the data
   moved in only once push and pull have both settled and nothing is owed any more. Until then it
   says the move is under way; if the data is still owed, it says it stays here until the next sync. */
const mocks = vi.hoisted(() => {
  const state = { hasData: true, owed: false, sheets: [] }
  state.toast = vi.fn()
  state.setUser = vi.fn()
  state.pushState = vi.fn()
  state.pullState = vi.fn()
  state.loadConfig = vi.fn(async () => null)
  state.passkeyRegister = vi.fn(async name => ({ id: 'u9', name }))
  state.snapshot = () => ({
    config: null, S: {}, user: null, linkCode: null,
    setUser: state.setUser, adoptProfile: vi.fn(), setGuest: vi.fn(), loadConfig: state.loadConfig,
    pushState: state.pushState, pullState: state.pullState,
    unsyncedChanges: () => ({ owed: state.owed, count: state.owed ? 1 : 0 }),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => mocks.hasData }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => true, passkeyLogin: vi.fn(), passkeyRegister: (...a) => mocks.passkeyRegister(...a), passkeyError: (e, m) => m,
  BIO: 'your fingerprint', bio: () => 'your fingerprint',
  api: vi.fn(), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
  createPasskey: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))

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
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)
function type(el, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Opens "Create new profile", names it and confirms; the sheet closes before the toasts.
async function register(name = 'Cleo') {
  const close = vi.fn()
  const page = mount(<Login />)
  act(() => button(page, 'Create new profile').click())
  const sheet = mount(mocks.sheets.at(-1)(close))
  type(sheet.querySelector('input[placeholder="Your name"]'), name)
  act(() => button(sheet, 'Create passkey').click())
  await settle()
  return close
}

beforeEach(() => {
  mocks.hasData = true
  mocks.owed = false
  mocks.sheets.length = 0
  for (const f of [mocks.toast, mocks.setUser, mocks.pushState, mocks.pullState, mocks.passkeyRegister]) f.mockClear()
  mocks.pushState.mockReset()
  mocks.pullState.mockReset()
})
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login: creating a profile on a guest copy with data', () => {
  it.each([
    [false, LANDED],
    [true, KEPT],
  ])('says the move is under way, and only after push and pull have settled (owed %s) says how it went', async (owed, result) => {
    mocks.owed = owed
    const push = deferred(), pull = deferred()
    mocks.pushState.mockReturnValue(push.promise)
    mocks.pullState.mockReturnValue(pull.promise)
    const close = await register()
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
