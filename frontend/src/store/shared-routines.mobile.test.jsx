// @vitest-environment happy-dom
// Phone persistence of shared routines: the store and native write helper are real.
// Native file reads and the API use synthetic fixtures; no physical device is required.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  return { files: new Map(), offline: false }
})
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Documents: 'DOCUMENTS', Cache: 'CACHE', LibraryNoCloud: 'LIBRARY_NO_CLOUD' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ path, directory }) => {
      const data = h.files.get(directory + '/' + path)
      if (data == null) throw new Error('File does not exist')
      return { data }
    },
    writeFile: async ({ path, directory, data }) => {
      h.files.set(directory + '/' + path, data)
      return { uri: 'file://' + path }
    },
  },
}))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {
  cancel: async () => {}, checkPermissions: async () => ({ display: 'granted' }),
  requestPermissions: async () => ({ display: 'granted' }), schedule: async () => {},
} }))
vi.mock('@capacitor/app', () => ({ App: { addListener: () => ({ remove() {} }) } }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true }, registerPlugin: () => ({}),
}))
vi.mock('../lib/api.js', () => ({
  setRemoteAuth: vi.fn(), setAccessHeaders: vi.fn(),
  api: vi.fn(async path => {
    if (h.offline) throw new TypeError('Failed to fetch')
    if (path === '/api/shares') return {
      incoming: [{ id: 'test-share', state: 'accepted', from: { id: 'test-sender', name: 'Test Sender' },
        unit: 'kg', hash: 'test-hash', routine: { id: 'test-source', name: 'Test Routine',
          ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] } }],
      outgoing: [], etag: 'test-etag',
    }
    return {}
  }),
}))

const USER = { id: 'test-recipient', name: 'Test Recipient' }
const { DEF } = await import('./useStore.js')
const file = name => JSON.parse(h.files.get('DATA/' + name))
let store
beforeEach(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  vi.resetModules(); localStorage.clear(); h.files.clear(); h.offline = false
})
afterEach(() => { store?.setState({ user: null, ready: false }); vi.unstubAllEnvs() })

async function load() {
  const { useStore, DEF } = await import('./useStore.js')
  store = useStore
  store.setState({ user: USER, S: structuredClone(DEF), ready: false })
  await store.getState().loadShares()
  // The native helper crosses a dynamic import before writing.
  await vi.waitFor(() => expect(h.files.has('DATA/opengym-shared.json')).toBe(true))
  return file('opengym-shared.json')
}

it('mirrors gym_shared_v1 to the native share file, independently of S', async () => {
  const saved = await load()
  expect(saved).toEqual(JSON.parse(localStorage.getItem('gym_shared_v1')))
  expect(saved.incoming[0].routine.name).toBe('Test Routine')
  expect(JSON.stringify(store.getState().S)).not.toContain('Test Routine')
})

it.each([false, true])('offline cold boot after storage eviction, foreign owner=%s', async foreign => {
  const saved = { uid: USER.id, etag: 'test-etag', fetchedAt: 1000, outgoing: [], incoming: [{
    id: 'test-share', state: 'accepted', from: { id: 'test-sender', name: 'Test Sender' },
    unit: 'kg', hash: 'test-hash', routine: { id: 'test-source', name: 'Test Routine',
      ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
  }] }
  const state = { ...structuredClone(DEF), _ts: 1000, week: { 1: ['shared:test-share'] } }
  h.files.set('DATA/opengym-state.json', JSON.stringify(state))
  h.files.set('DATA/opengym-state-owner.json', JSON.stringify({ owner: USER.id, ts: state._ts }))
  // iOS keeps the pairing in Library/NoCloud; seeding it there takes the normal boot path.
  h.files.set('LIBRARY_NO_CLOUD/opengym-remote.json', JSON.stringify({ mode: 'remote', base: 'https://gym.example.com', token: 'test-token', user: USER }))
  h.files.set('DATA/opengym-shared.json', JSON.stringify(foreign ? { ...saved, uid: 'test-other-recipient' } : saved))
  h.offline = true
  const { useStore } = await import('./useStore.js')
  store = useStore
  await store.getState().boot()
  const { sharedViewOf } = await import('../lib/shared-routines.js')
  expect(store.getState().ready).toBe(true)
  expect(store.getState().sync.offline).toBe(true)
  expect(store.getState().S.week[1]).toEqual(['shared:test-share'])
  if (foreign) {
    expect(store.getState().shares).toBeNull()
    expect(sharedViewOf(store.getState()).routines).toEqual([])
  } else {
    expect(store.getState().user?.id).toBe(USER.id)
    expect(localStorage.getItem('gym_owner')).toBe(USER.id)
    expect(file('opengym-shared.json')).toEqual(saved)
    expect(store.getState().shares).toEqual(saved)
    expect(sharedViewOf(store.getState()).routines[0].name).toBe('Test Routine')
  }
})
