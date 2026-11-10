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
   - signs it out (user: null, ready: false), so anything still in flight finds no account to
     work for, and
   - disposes of it (disposeStore, NATG-658): its timers stop, the poll and any save or push still
     on its debounce included, and every listener it added to window and document comes off, so an
     event a later test sends (a 'storage' write of gym_owner, an 'online', a 'focus') reaches only
     that test's stores. Left on, the gym_owner 'storage' listener handed every earlier store over
     to the new owner.
   A test file imports freshStore and writes no sign-out or clean-up of its own. Its own afterEach
   hooks run before this one (vitest runs afterEach hooks last-registered first), so a file that
   sends pagehide to flush what its stores owe still reaches them.
   This relies on vitest's per-file isolation (the default, which vite.config.js keeps): each test
   file loads this module, and so registers the afterEach, afresh. Turning isolation off would leave
   every file after the first without clean-up.

   Use it for a store per test, from a test or a beforeEach. A store loaded in beforeAll for a whole
   file would be signed out and disposed of after its first test.

   The modules the store imports are mocked by the test file's own vi.mock calls, as with any
   import; vi.resetModules() runs first, so the test file loads anything that has to share the
   store's module instances (useUI, sheets.jsx, lib/media-store.js) after freshStore(), not before. */
import { afterEach, vi } from 'vitest'

let loaded = []

export async function freshStore() {
  vi.resetModules()
  const store = await import('../store/useStore.js')
  loaded.push(store)
  return store
}

// The afterEach below; exported for fresh-store.test.js, which checks it within one test.
export function releaseStores() {
  for (const { useStore, disposeStore } of loaded) {
    useStore.setState({ user: null, ready: false })
    disposeStore()
  }
  loaded = []
}

afterEach(releaseStores)
