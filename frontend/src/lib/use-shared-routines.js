// The routines shared with you, as the screens read them (NATG-486): a hook for components and a
// plain read for the code that runs outside one (starting a workout, the sheets' actions). Both go
// through sharedViewOf, which hands back the same object until the lists, the account or the
// weight unit change. A hook beside the pure helpers, as use-shared-counts.js is, so sheets.jsx
// can use it without importing a view.
import { useStore } from '../store/useStore.js'
import { sharedViewOf } from './shared-routines.js'

export const useSharedRoutines = () => useStore(sharedViewOf)
export const sharedNow = () => sharedViewOf(useStore.getState?.() ?? null)
