// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'
import { createMediaStore, memoryBackend, _setMediaStore } from '../lib/media-store.js'
import { sha256Hex } from '../lib/sha256.js'
import { jpeg, png } from '../lib/media-samples.test-util.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// NATG-557: Settings > Import backup writes a zip's photos into the media store before importBackup
// checks, one last time, that the import's account is still the one signed in. When the account
// changes while the photos are written and the import is refused, the store is left as it was
// before the import: the photos it added go again, and the photos already here stay as they were.
// The real storeBackupMedia and the real media store; the account change is a mocked store's.
const mocks = vi.hoisted(() => {
  const state = { S: null, user: null, listeners: new Set(), sheets: [], tokens: [], stale: new Set(), read: null }
  state.importToken = vi.fn(() => { const t = Object.freeze({ n: state.tokens.length }); state.tokens.push(t); return t })
  state.importConflict = vi.fn(async () => null)
  state.importIsCurrent = vi.fn(t => !!t && !state.stale.has(t))
  state.importBackup = vi.fn((b, { token } = {}) => state.importIsCurrent(token))
  state.toast = vi.fn()
  state.syncMedia = vi.fn()
  state.confirmSheet = vi.fn(() => { state.sheets.push({ id: 'confirm' }); return { id: 'confirm', close: vi.fn() } })
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
// The file read stands in for a zip already opened; storing and taking back its files is real.
vi.mock('../lib/backup-media.js', async importOriginal => ({
  ...await importOriginal(),
  readBackupFile: async () => mocks.read,
}))
vi.mock('../lib/media-sync.js', async importOriginal => ({ ...await importOriginal(), syncMedia: (...a) => mocks.syncMedia(...a) }))
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
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

const refFor = async (bytes, mime) => ({ kind: 'image', hash: await sha256Hex(bytes), mime, size: bytes.length, width: 4, height: 3, at: 1 })
const fileOf = async (bytes, mime) => ({ hash: await sha256Hex(bytes), entry: { name: 'media/x', size: bytes.length, blob: new Blob([bytes], { type: mime }) } })
const records = async media => (await media.list())
  .map(({ hash, pending, rejected }) => ({ hash, pending, rejected }))
  .sort((a, b) => a.hash.localeCompare(b.hash))

let host, root, media, refs
beforeEach(async () => {
  mocks.S = { unit: 'kg', restSec: 90, workouts: [], routines: [], exWeights: {} }
  mocks.user = { id: 'A', name: 'Ana' }
  mocks.listeners.clear()
  mocks.sheets = []
  mocks.tokens = []
  mocks.stale = new Set()
  for (const f of [mocks.importToken, mocks.importConflict, mocks.importIsCurrent, mocks.importBackup, mocks.toast, mocks.confirmSheet, mocks.syncMedia]) f.mockClear()

  // On this device before the import: a photo on the server, one still owed to it. The backup
  // carries both, and a photo this device has never had.
  const synced = jpeg(), owed = png(), fresh = png(3, 2)
  refs = { synced: await refFor(synced, 'image/jpeg'), owed: await refFor(owed, 'image/png'), fresh: await refFor(fresh, 'image/png') }
  media = createMediaStore(memoryBackend())
  await media.put(refs.synced.hash, new Blob([synced]), { mime: 'image/jpeg', pending: false })
  await media.put(refs.owed.hash, new Blob([owed]), { mime: 'image/png', pending: true })
  _setMediaStore(media)
  mocks.read = {
    state: { workouts: [], routines: [], customEx: [{ id: 'a', media: refs.synced }, { id: 'b', media: refs.owed }, { id: 'c', media: refs.fresh }] },
    files: [await fileOf(synced, 'image/jpeg'), await fileOf(owed, 'image/png'), await fileOf(fresh, 'image/png')],
  }

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  _setMediaStore(null)
})

async function confirmImport() {
  act(() => root.render(<Settings page="data" />))
  const input = [...host.querySelectorAll('input[type="file"]')].find(i => i.accept.startsWith('.json'))
  Object.defineProperty(input, 'files', { value: [new File(['PK'], 'backup.zip')], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(mocks.confirmSheet).toHaveBeenCalled())
  await act(async () => { await mocks.confirmSheet.mock.calls[0][0].onConfirm() })
}

describe('Settings import of a zip, when the account changes while its photos are written', () => {
  it('is refused, and leaves the media store as it was before: the new photo gone, the photos already here as they were', async () => {
    const before = await records(media)
    // The account changes once the first photo is in.
    const put = media.put
    media.put = async (...a) => { const was = await put(...a); if (!mocks.stale.size) mocks.accountChanges(); return was }
    await confirmImport()
    expect(mocks.importBackup).toHaveBeenCalledTimes(1)
    expect(mocks.importBackup).toHaveLastReturnedWith(false)
    expect(await records(media)).toEqual(before)
    expect(await media.has(refs.fresh.hash)).toBe(false)
    expect(await media.get(refs.synced.hash)).toMatchObject({ pending: false })
    expect(await media.get(refs.owed.hash)).toMatchObject({ pending: true })
    expect(mocks.syncMedia).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalledWith('Backup imported')
  })
})

describe('Settings import of a zip, with no account change', () => {
  it('keeps every photo it brought, pending, and sends them', async () => {
    await confirmImport()
    expect(mocks.importBackup).toHaveLastReturnedWith(true)
    for (const r of [refs.synced, refs.owed, refs.fresh]) expect(await media.get(r.hash)).toMatchObject({ pending: true })
    expect(mocks.syncMedia).toHaveBeenCalledWith({ force: true })
    expect(mocks.toast).toHaveBeenCalledWith('Backup imported')
  })
})
