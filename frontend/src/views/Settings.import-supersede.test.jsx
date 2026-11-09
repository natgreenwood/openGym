// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// NATG-562: a second backup chosen in Settings > Import backup while the first is still being
// read, checked against the server or waiting on its confirm takes over. The first does nothing
// more: its confirm, if open, closes without importing, no "Backup imported" is said for it and
// none of its photos are stored. The account checks of NATG-535 stay as they were.
const mocks = vi.hoisted(() => {
  const state = { S: null, user: null, listeners: new Set(), sheets: [], tokens: [], stale: new Set() }
  state.importToken = vi.fn(() => { const t = Object.freeze({ n: state.tokens.length }); state.tokens.push(t); return t })
  state.importConflict = vi.fn(async () => null)
  state.importIsCurrent = vi.fn(t => !!t && !state.stale.has(t))
  // As the store did before NATG-562 when nothing was owed: "Merge them in" is the backup plus the
  // server copy its check read, this device's copy left out; anything else replaces.
  state.importBackup = vi.fn((b, { mergeWith, token } = {}) => {
    if (!state.importIsCurrent(token)) return false
    const keys = new Set(b.workouts.map(w => w.id))
    state.S = { ...state.S, workouts: [...b.workouts, ...(mergeWith ? mergeWith.state.workouts.filter(w => !keys.has(w.id)) : [])] }
    return true
  })
  state.toast = vi.fn()
  state.readBackupFile = vi.fn()
  state.storeBackupMedia = vi.fn(async () => ({ added: [] }))
  state.handle = id => {
    const h = { id, close: vi.fn(() => { state.sheets = state.sheets.filter(x => x.id !== id) }) }
    state.sheets.push({ id })
    return h
  }
  state.menuSheet = vi.fn(() => state.handle('menu' + state.menuSheet.mock.calls.length))
  state.confirmSheet = vi.fn(() => state.handle('confirm' + state.confirmSheet.mock.calls.length))
  state.accountChanges = () => { for (const t of state.tokens) state.stale.add(t); for (const l of [...state.listeners]) l() }
  state.snapshot = () => ({
    S: state.S, user: state.user, config: null,
    update: vi.fn(), replaceState: vi.fn(), resetEverything: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
    importConflict: state.importConflict, importBackup: state.importBackup, importIsCurrent: state.importIsCurrent, importToken: state.importToken,
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
  readBackupFile: (...a) => mocks.readBackupFile(...a),
  backupImportError: () => 'error',
  storeBackupMedia: (...a) => mocks.storeBackupMedia(...a),
  undoBackupMedia: vi.fn(),
}))
vi.mock('../lib/media-sync.js', () => ({ syncMedia: vi.fn(), fetchToStore: vi.fn() }))
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

const workout = id => ({ id, d: '2026-09-20', start: 1, end: 2, entries: [] })
const ids = xs => xs.map(x => x.id).sort()
// The reporter's account (A): the server and this device hold `a-only`.
const SERVER = { workouts: [workout('a-only')] }
const FILE_1 = { state: { workouts: [workout('file-1')], routines: [] }, files: [] }
const FILE_2 = { state: { workouts: [workout('file-2')], routines: [] }, files: [] }
const conflictOf = token => ({ workouts: 1, state: SERVER, rev: 7, token })

let host, root
beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, workouts: [workout('a-only')], routines: [], exWeights: {} }
  mocks.user = { id: 'A', name: 'Ana' }
  mocks.listeners.clear()
  mocks.sheets = []
  mocks.tokens = []
  mocks.stale = new Set()
  for (const f of [mocks.importToken, mocks.importConflict, mocks.importIsCurrent, mocks.importBackup, mocks.toast, mocks.menuSheet, mocks.confirmSheet, mocks.readBackupFile, mocks.storeBackupMedia]) f.mockClear()
  mocks.importConflict.mockImplementation(async (b, token) => conflictOf(token))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Settings page="data" />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  mocks.importConflict.mockReset()
  mocks.readBackupFile.mockReset()
})

// The hidden file input, set directly: with a sheet open the page behind it is inert, so this is
// how the reporter reached a second pick while the first confirm was open.
const choose = async read => {
  mocks.readBackupFile.mockImplementationOnce(async () => read)
  const input = [...host.querySelectorAll('input[type="file"]')].find(i => i.accept.startsWith('.json'))
  Object.defineProperty(input, 'files', { value: [new File(['{}'], 'backup.json')], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => {})
}
const item = (n, label) => mocks.menuSheet.mock.calls[n][0].items.find(i => i.label === label)
const press = async fn => { await act(async () => { await fn() }) }
const imported = () => mocks.toast.mock.calls.filter(([m]) => m === 'Backup imported').length

describe('Settings import, a second file chosen while the first is in progress', () => {
  it('the reporter\'s sequence: the first menu closes, and answering both keeps file-2 (AC1)', async () => {
    await choose(FILE_1)
    const first = mocks.menuSheet.mock.results[0].value
    await choose(FILE_2)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(mocks.menuSheet).toHaveBeenCalledTimes(2)
    expect(mocks.sheets.map(s => s.id)).toEqual([mocks.menuSheet.mock.results[1].value.id])
    await press(item(1, 'Merge them in').onClick)
    expect(ids(mocks.S.workouts)).toEqual(['a-only', 'file-2'])
    // A click on the first menu that got in before it closed
    await press(item(0, 'Merge them in').onClick)
    await press(item(0, 'Replace anyway').onClick)
    expect(mocks.importBackup).toHaveBeenCalledTimes(1)
    expect(ids(mocks.S.workouts)).toEqual(['a-only', 'file-2'])
    expect(imported()).toBe(1)
  })

  it('a first import still asking the server opens no menu, and only the second imports (AC3)', async () => {
    const answers = []
    mocks.importConflict.mockImplementation((b, token) => new Promise(r => answers.push(() => r(conflictOf(token)))))
    await choose(FILE_1)
    await choose(FILE_2)
    expect(mocks.importConflict).toHaveBeenCalledTimes(2)
    await act(async () => { answers[1]() })          // the second's check answers first
    await act(async () => { answers[0]() })          // then the first's
    expect(mocks.menuSheet).toHaveBeenCalledTimes(1)
    expect(mocks.sheets).toHaveLength(1)
    await press(item(0, 'Merge them in').onClick)
    expect(mocks.importBackup).toHaveBeenCalledTimes(1)
    expect(mocks.importBackup).toHaveBeenCalledWith(FILE_2.state, { mergeWith: conflictOf(mocks.tokens[1]), token: mocks.tokens[1] })
    expect(imported()).toBe(1)
  })

  it('a first import still reading its file is not checked against the server at all', async () => {
    let finishRead
    mocks.readBackupFile.mockImplementationOnce(() => new Promise(r => { finishRead = r }))
    const input = [...host.querySelectorAll('input[type="file"]')].find(i => i.accept.startsWith('.json'))
    Object.defineProperty(input, 'files', { value: [new File(['{}'], 'backup.json')], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await choose(FILE_2)
    await act(async () => { finishRead(FILE_1) })
    expect(mocks.importConflict).toHaveBeenCalledTimes(1)
    expect(mocks.importConflict).toHaveBeenCalledWith(FILE_2.state, mocks.tokens[1])
    expect(mocks.menuSheet).toHaveBeenCalledTimes(1)
  })

  it('the plain confirm closes too, and its Import neither imports nor stores the first file\'s photos', async () => {
    mocks.importConflict.mockImplementation(async () => null)
    await choose({ ...FILE_1, files: [{ name: 'media/a.jpg' }] })
    const first = mocks.confirmSheet.mock.results[0].value
    await choose(FILE_2)
    expect(first.close).toHaveBeenCalledTimes(1)
    await press(mocks.confirmSheet.mock.calls[0][0].onConfirm)
    expect(mocks.storeBackupMedia).not.toHaveBeenCalled()
    expect(mocks.importBackup).not.toHaveBeenCalled()
    expect(imported()).toBe(0)
    await press(mocks.confirmSheet.mock.calls[1][0].onConfirm)
    expect(mocks.importBackup).toHaveBeenCalledWith(FILE_2.state, { mergeWith: null, token: mocks.tokens[1] })
    expect(imported()).toBe(1)
  })

  // Tester, NATG-562: the page is keyed by its path (App.jsx), so going to Home and back mounts a
  // new Settings. The first import is still this tab's, and the second still takes over.
  it('a first import started before Settings was left and opened again is still superseded', async () => {
    const answers = []
    mocks.importConflict.mockImplementation((b, token) => new Promise(r => answers.push(() => r(conflictOf(token)))))
    await choose({ ...FILE_1, files: [{ name: 'media/a.jpg' }] })
    act(() => root.unmount())
    root = createRoot(host)
    act(() => root.render(<Settings page="data" />))
    await choose(FILE_2)
    await act(async () => { answers[1]() })
    await act(async () => { answers[0]() })
    expect(mocks.menuSheet).toHaveBeenCalledTimes(1)
    expect(mocks.confirmSheet).not.toHaveBeenCalled()
    await press(item(0, 'Merge them in').onClick)
    expect(mocks.storeBackupMedia).not.toHaveBeenCalled()
    expect(mocks.importBackup).toHaveBeenCalledTimes(1)
    expect(mocks.importBackup).toHaveBeenCalledWith(FILE_2.state, { mergeWith: conflictOf(mocks.tokens[1]), token: mocks.tokens[1] })
    expect(imported()).toBe(1)
  })

  it('the account check still holds for the import that took over', async () => {
    await choose(FILE_1)
    await choose(FILE_2)
    const second = mocks.menuSheet.mock.results[1].value
    mocks.accountChanges()
    expect(second.close).toHaveBeenCalledTimes(1)
    await press(item(1, 'Merge them in').onClick)
    expect(mocks.importBackup).not.toHaveBeenCalled()
    expect(imported()).toBe(0)
  })
})
