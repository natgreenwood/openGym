/* A store of a test's own, loaded the way a page load loads it (NATG-615).

   store/useStore.js keeps state outside its Zustand state (whose copy the browser holds, what it
   owes, the revision it last saw), and loading it adds listeners to window and document: the poll's
   focus, online, pageshow and visibilitychange checks, the pagehide and pause flush, and the
   'storage' listeners that follow another tab's sign-in, sync and save. useStore.setState resets
   none of that, so a test that needs a clean store loads a new one with freshStore(). It resolves
   to the new module's exports, as `await import('../store/useStore.js')` would:

     const { useStore, DEF } = await freshStore()

   The contract. Importing this file registers an afterEach that, for every store freshStore()
   loaded during the test:
   - signs it out (user: null, ready: false), so its poll and anything still in flight find no
     account to work for, and
   - removes every listener added to window and document while it loaded, so an event a later test
     sends (a 'storage' write of gym_owner, an 'online', a 'focus') reaches only that test's stores.
     Left on, the gym_owner 'storage' listener handed every earlier store over to the new owner.
   A test file imports freshStore and writes no sign-out or listener clean-up of its own. Its own
   afterEach hooks run before this one (vitest runs afterEach hooks last-registered first), so a
   file that sends pagehide to flush what its stores owe still reaches them.
   This relies on vitest's per-file isolation (the default, which vite.config.js keeps): each test
   file loads this module, and so registers the afterEach, afresh. Turning isolation off would leave
   every file after the first without clean-up.
   The listeners are recorded however the test has instrumented addEventListener: a vi.spyOn on it
   made before freshStore(), or while the store loads, still sees every call, and every listener
   is still taken off.

   Use it for a store per test, from a test or a beforeEach. A store loaded in beforeAll for a whole
   file would be signed out after its first test.

   What it does not undo: the poll's timer keeps running on a store it signed out, and does nothing
   there. The modules the store imports are mocked by the test file's own vi.mock calls, as with
   any import; vi.resetModules() runs first, so the test file loads anything that has to share the
   store's module instances (useUI, sheets.jsx, lib/media-store.js) after freshStore(), not before. */
import { afterEach, vi } from 'vitest'

let loaded = []

// Records what is added to `target` until the returned function puts addEventListener back.
// Defined, not assigned: in the happy-dom environment window.addEventListener is a getter and
// setter, and once a test has spied on it an assignment no longer changes what the getter returns,
// so the store's listeners went past the recording and outlived the test. What was there before
// (a spy included) is what the wrapper calls, and its descriptor is what goes back.
function recordListeners(target, into) {
  const before = Object.getOwnPropertyDescriptor(target, 'addEventListener')
  const add = target.addEventListener
  let recording = true
  function addEventListener(type, listener, options) {
    if (recording) into.push({ target, type, listener, options })
    return add.call(this, type, listener, options)
  }
  Object.defineProperty(target, 'addEventListener', { value: addEventListener, writable: true, configurable: true, enumerable: before?.enumerable ?? false })
  return () => {
    recording = false
    // A spy made while the store loaded wraps this one and is the test's to restore; restored, it
    // puts back this wrapper, which from now on only passes calls on.
    if (Object.getOwnPropertyDescriptor(target, 'addEventListener')?.value !== addEventListener) return
    if (before) Object.defineProperty(target, 'addEventListener', before)
    else delete target.addEventListener
  }
}

export async function freshStore() {
  vi.resetModules()
  const listeners = []
  const targets = [globalThis.window, globalThis.document].filter(Boolean)
  const restore = targets.map(target => recordListeners(target, listeners))
  let store
  try {
    store = await import('../store/useStore.js')
  } finally {
    for (const undo of restore.reverse()) undo()
  }
  loaded.push({ useStore: store.useStore, listeners })
  return store
}

// The afterEach below; exported for fresh-store.test.js, which checks it within one test.
export function releaseStores() {
  for (const { useStore, listeners } of loaded) {
    useStore.setState({ user: null, ready: false })
    for (const { target, type, listener, options } of listeners) target.removeEventListener(type, listener, options)
  }
  loaded = []
}

afterEach(releaseStores)
