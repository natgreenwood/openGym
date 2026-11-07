// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* NATG-535 SEC-02-R1, with the real store under Settings: a tab that slept through another tab's
   round trip (A signs out and in again, A → B → A, or a guest's browser signed in and out) finds
   the owner key back where it was when the owner events reach it. The events themselves end the
   import begun before: its confirm closes, a check still asking the server opens no confirm when
   it answers, nothing is written, and "Backup imported" is not said. */
const mocks = vi.hoisted(() => {
  const state = { sheets: [], data: null }
  state.toast = vi.fn()
  state.api = vi.fn((path, opts) => (path === '/api/data' && !opts?.method ? state.data() : Promise.resolve({ ok: true })))
  state.handle = id => {
    const h = { id, close: vi.fn(() => { state.sheets = state.sheets.filter(x => x.id !== id) }) }
    state.sheets.push({ id })
    return h
  }
  state.menuSheet = vi.fn(() => state.handle('menu'))
  state.confirmSheet = vi.fn(() => state.handle('confirm'))
  return state
})
vi.mock('../lib/api.js', () => ({
  api: (...a) => mocks.api(...a), setRemoteAuth: vi.fn(),
  webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), passkeyError: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: vi.fn(), sheets: mocks.sheets })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/backup-media.js', () => ({
  readBackupFile: async () => ({ state: JSON.parse(JSON.stringify(mocks.backup)), files: [] }),
  backupImportError: () => 'error',
  storeBackupMedia: vi.fn(),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: (...a) => mocks.confirmSheet(...a), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: (...a) => mocks.menuSheet(...a),
}))

import Settings from './Settings.jsx'
import { DEF, useStore } from '../store/useStore.js'

globalThis.__APP_VERSION__ ??= 'test'

const clone = v => JSON.parse(JSON.stringify(v))
const workout = (id, d = '2026-09-20') => ({ id, d, start: 1, end: 2, entries: [] })
const SERVER_A = { ...clone(DEF), _ts: 300, restSec: 60, workouts: [workout('w1'), workout('w2'), workout('a-only', '2026-09-26')], _rev: 7 }
const puts = () => mocks.api.mock.calls.filter(([, o]) => o?.method === 'PUT')
const historical = (oldValue, newValue) =>
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue, newValue })) })
// This tab's own idea of the owner made the key's, as after a load (useStore's gym_owner listener).
const settled = owner => {
  if (owner) localStorage.setItem('gym_owner', owner); else localStorage.removeItem('gym_owner')
  window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner' }))
}
const asA = ({ settle = true } = {}) => {
  if (settle) settled('A'); else localStorage.setItem('gym_owner', 'A')
  localStorage.setItem('gym_sync', JSON.stringify({ rev: 6, ts: 200 }))
  useStore.setState({ S: { ...clone(DEF), _ts: 200, workouts: [workout('w1')] }, user: { id: 'A' }, ready: true, sync: { offline: false, pending: false, lastSynced: 0 } })
}
const asGuest = () => {
  settled(null)
  useStore.setState({ S: { ...clone(DEF), _ts: 200, workouts: [workout('w1'), workout('guest-only', '2026-09-28')] }, user: null, ready: true })
}

let host, root
beforeEach(() => {
  localStorage.clear()
  mocks.sheets = []
  mocks.backup = { ...clone(DEF), _ts: 50, restSec: 120, workouts: [workout('w1'), workout('w2')] }
  mocks.data = () => Promise.resolve({ state: clone(SERVER_A), rev: 7 })
  for (const f of [mocks.api, mocks.toast, mocks.menuSheet, mocks.confirmSheet]) f.mockClear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

async function chooseFile() {
  act(() => root.render(<Settings page="data" />))
  const input = [...host.querySelectorAll('input[type="file"]')].find(i => i.accept.startsWith('.json'))
  Object.defineProperty(input, 'files', { value: [new File(['{}'], 'backup.json')], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => {})
}
const press = async fn => { await act(async () => { await fn() }) }
// The copy, its saved form and the server stay as they were, after the push debounce too, and no
// success is said.
async function expectNothingImported(run) {
  const S = useStore.getState().S
  const saved = localStorage.getItem('gym_state_v1')
  const before = puts().length
  await run()
  vi.advanceTimersByTime(5000)
  expect(useStore.getState().S).toBe(S)
  expect(localStorage.getItem('gym_state_v1')).toBe(saved)
  expect(puts().length).toBe(before)
  expect(mocks.toast).not.toHaveBeenCalledWith('Backup imported')
}

// Without settling the owner. The owner events in the other tests leave this store handed over to
// the new owner (it writes nothing until it has taken that owner's saved copy), as a real tab would
// be; signing in as A, as that tab then does, is what ends it. This test used to rely on running
// first instead, and failed in any other order.
describe('with no owner event, the import goes as before', () => {
  it('with no owner event the menu stays open, and "Merge them in" imports and says so', async () => {
    asA({ settle: false })
    useStore.getState().setUser({ id: 'A' })
    await chooseFile()
    const sheet = mocks.menuSheet.mock.results[0].value
    act(() => { useStore.setState({ ready: true }) })   // the store moves for another reason
    expect(sheet.close).not.toHaveBeenCalled()
    await press(mocks.menuSheet.mock.calls[0][0].items.find(i => i.label === 'Merge them in').onClick)
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1', 'w2', 'a-only'])
    expect(mocks.toast).toHaveBeenCalledWith('Backup imported')
  })
})

describe('owner events Settings hears of only after the key is back where it was', () => {
  for (const [label, trip] of [
    ['A → signed out → A', [['A', null], [null, 'A']]],
    ['A → B → A', [['A', 'B'], ['B', 'A']]],
  ]) {
    it(`${label}: the conflict menu closes, and neither choice imports`, async () => {
      asA()
      await chooseFile()
      expect(mocks.menuSheet).toHaveBeenCalledTimes(1)
      const sheet = mocks.menuSheet.mock.results[0].value
      const items = mocks.menuSheet.mock.calls[0][0].items
      localStorage.setItem('gym_owner', 'A')   // back at A before any event reaches this tab
      for (const [from, to] of trip) historical(from, to)
      expect(sheet.close).toHaveBeenCalledTimes(1)
      expect(useStore.getState().user?.id).toBe('A')
      // a click that got in before the menu closed
      await expectNothingImported(async () => {
        await press(items.find(i => i.label === 'Merge them in').onClick)
        await press(items.find(i => i.label === 'Replace anyway').onClick)
      })
    })
  }

  it('the plain "Import backup?" confirm closes too, and its Import imports nothing', async () => {
    asA()
    mocks.data = () => Promise.resolve({ state: clone(mocks.backup), rev: 7 })   // nothing to warn about
    await chooseFile()
    expect(mocks.confirmSheet).toHaveBeenCalledTimes(1)
    const sheet = mocks.confirmSheet.mock.results[0].value
    historical('A', null)
    historical(null, 'A')
    expect(sheet.close).toHaveBeenCalledTimes(1)
    await expectNothingImported(() => press(mocks.confirmSheet.mock.calls[0][0].onConfirm))
  })

  it('a check still asking the server across the round trip opens no confirm when it answers', async () => {
    asA()
    let answer
    mocks.data = () => new Promise(r => { answer = r })
    await chooseFile()
    expect(mocks.api).toHaveBeenCalledWith('/api/data')
    historical('A', 'B')
    historical('B', 'A')
    await expectNothingImported(async () => {
      await act(async () => { answer({ state: clone(SERVER_A), rev: 7 }) })
      await act(async () => {})
    })
    expect(mocks.menuSheet).not.toHaveBeenCalled()
    expect(mocks.confirmSheet).not.toHaveBeenCalled()
  })

  it('guest → A → guest: the guest\'s menu closes, and neither choice imports', async () => {
    asGuest()
    await chooseFile()
    expect(mocks.menuSheet).toHaveBeenCalledTimes(1)
    const sheet = mocks.menuSheet.mock.results[0].value
    const items = mocks.menuSheet.mock.calls[0][0].items
    historical(null, 'A')
    historical('A', null)
    expect(sheet.close).toHaveBeenCalledTimes(1)
    await expectNothingImported(async () => {
      await press(items.find(i => i.label === 'Merge them in').onClick)
      await press(items.find(i => i.label === 'Replace anyway').onClick)
    })
  })

})
