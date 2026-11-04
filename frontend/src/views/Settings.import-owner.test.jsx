// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// NATG-535: Settings > Import backup asks the server first, then waits on a confirm. When another
// tab signs out, switches account or signs in from guest while it is open, the confirm closes and
// nothing is imported, whichever choice it offered; a click that lands before it closes does
// nothing either, and "Backup imported" is never said for an import that did not go.
const mocks = vi.hoisted(() => {
  const state = { S: null, user: null, current: true, conflict: null, listeners: new Set(), sheets: [] }
  state.importConflict = vi.fn(async () => state.conflict)
  state.importIsCurrent = vi.fn(() => state.current)
  state.importBackup = vi.fn(() => state.current)
  state.toast = vi.fn()
  state.handle = id => {
    const h = { id, close: vi.fn(() => { state.sheets = state.sheets.filter(x => x.id !== id) }) }
    state.sheets.push({ id })
    return h
  }
  state.menuSheet = vi.fn(() => state.handle('menu'))
  state.confirmSheet = vi.fn(() => state.handle('confirm'))
  // Another tab changed the account: the store moves (its owner listener), and its subscribers run.
  state.accountChanges = () => { state.current = false; for (const l of [...state.listeners]) l() }
  state.storeMoves = () => { for (const l of [...state.listeners]) l() }
  state.snapshot = () => ({
    S: state.S, user: state.user, config: null,
    update: vi.fn(), replaceState: vi.fn(), resetEverything: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
    importConflict: state.importConflict, importBackup: state.importBackup, importIsCurrent: state.importIsCurrent,
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  useStore.subscribe = l => { mocks.listeners.add(l); return () => mocks.listeners.delete(l) }
  return { useStore, DEF: { reminder: { time: '17:30' }, workouts: [] }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: vi.fn(), sheets: mocks.sheets })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/backup-media.js', () => ({
  readBackupFile: async () => ({ state: { workouts: [], routines: [] }, files: [] }),
  backupImportError: () => 'error',
  storeBackupMedia: vi.fn(),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.resolve({ ok: true })), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: (...a) => mocks.confirmSheet(...a), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: (...a) => mocks.menuSheet(...a),
}))

globalThis.__APP_VERSION__ ??= 'test'

let host, root
beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, workouts: [], routines: [], exWeights: {} }
  mocks.user = { id: 'A', name: 'Ana' }
  mocks.current = true
  mocks.conflict = null
  mocks.listeners.clear()
  mocks.sheets = []
  for (const f of [mocks.importConflict, mocks.importIsCurrent, mocks.importBackup, mocks.toast, mocks.menuSheet, mocks.confirmSheet]) f.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const CONFLICT = { workouts: 1, state: { workouts: [] }, rev: 7, uid: 'A', owner: 'A' }
async function pickBackup() {
  act(() => root.render(<Settings page="data" />))
  const input = [...host.querySelectorAll('input[type="file"]')].find(i => i.accept.startsWith('.json'))
  Object.defineProperty(input, 'files', { value: [new File(['{}'], 'backup.json')], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(mocks.importConflict).toHaveBeenCalled())
  await act(async () => {})
}
const menuItem = label => mocks.menuSheet.mock.calls[0][0].items.find(i => i.label === label)
const press = async fn => { await act(async () => { await fn() }) }

describe('Settings import confirm, when the account changes while it is open', () => {
  it('the conflict menu closes, and neither "Merge them in" nor "Replace anyway" imports anything', async () => {
    mocks.conflict = CONFLICT
    await pickBackup()
    const sheet = mocks.menuSheet.mock.results[0].value
    expect(sheet.close).not.toHaveBeenCalled()
    mocks.accountChanges()
    expect(sheet.close).toHaveBeenCalledTimes(1)
    expect(mocks.importIsCurrent).toHaveBeenLastCalledWith(CONFLICT)
    // a click that got in before the confirm closed
    await press(menuItem('Merge them in').onClick)
    await press(menuItem('Replace anyway').onClick)
    expect(mocks.importBackup).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalledWith('Backup imported')
  })

  it('the plain "Import backup?" confirm closes, and its Import imports nothing', async () => {
    await pickBackup()
    const sheet = mocks.confirmSheet.mock.results[0].value
    mocks.accountChanges()
    expect(sheet.close).toHaveBeenCalledTimes(1)
    await press(mocks.confirmSheet.mock.calls[0][0].onConfirm)
    expect(mocks.importBackup).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalledWith('Backup imported')
  })

  it('no confirm opens when the account changed while the server was being asked', async () => {
    mocks.conflict = CONFLICT
    mocks.importConflict.mockImplementationOnce(async () => { mocks.current = false; return CONFLICT })
    await pickBackup()
    expect(mocks.menuSheet).not.toHaveBeenCalled()
    expect(mocks.confirmSheet).not.toHaveBeenCalled()
  })

  it('an import the store refuses at the last moment is not toasted as imported', async () => {
    await pickBackup()
    mocks.importBackup.mockReturnValueOnce(false)
    await press(mocks.confirmSheet.mock.calls[0][0].onConfirm)
    expect(mocks.importBackup).toHaveBeenCalledTimes(1)
    expect(mocks.toast).not.toHaveBeenCalledWith('Backup imported')
  })
})

describe('Settings import confirm, with no account change', () => {
  it('stays open while the store moves, and "Merge them in" imports and says so', async () => {
    mocks.conflict = CONFLICT
    await pickBackup()
    const sheet = mocks.menuSheet.mock.results[0].value
    mocks.storeMoves()
    expect(sheet.close).not.toHaveBeenCalled()
    await press(menuItem('Merge them in').onClick)
    expect(mocks.importBackup).toHaveBeenCalledWith(expect.anything(), { mergeWith: CONFLICT })
    expect(mocks.toast).toHaveBeenCalledWith('Backup imported')
  })

  it('stops watching once the confirm has closed some other way', async () => {
    await pickBackup()
    expect(mocks.listeners.size).toBe(1)
    mocks.sheets = []   // dismissed: Cancel, a swipe, Escape
    mocks.storeMoves()
    expect(mocks.listeners.size).toBe(0)
  })
})
