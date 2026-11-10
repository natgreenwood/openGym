/* Loads the store's heavy imports once, before a test file's first store (NATG-663).

   The first load of store/useStore.js transforms everything it imports, the 1 MB exercise table and
   the sync and mobile libraries among them. Cold, under a parallel run, that took seconds, and a
   file paid it inside whichever test or hook loaded its first store: past the 5 s test timeout, or
   the 10 s hook timeout (NATG-691). A file that loads stores awaits this at collection, at the top
   level of the file, not in a hook or a test:

     await warmStoreImports()

   It does not load the store, so no store is left listening on window or document, and the
   file's stores still come only from freshStore() or the file's own import. vi.resetModules() (as
   freshStore() runs) clears the module instances but keeps the transforms, so every store the file
   loads afterwards finds them done. The test file's vi.mock calls apply here as to any import.

   When useStore.js gains an import that is slow to transform, add it to this list. */
export async function warmStoreImports() {
  await Promise.all([
    import('../lib/exercises.js'), import('../lib/mobile.js'), import('../lib/sync-merge.js'), import('../lib/media-store.js'),
    import('../lib/remote.js'), import('../lib/health-sync.js'), import('../lib/i18n.js'),
  ])
}
