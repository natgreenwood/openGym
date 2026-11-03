// How many people each of your routines is shared with, `{ [routineId]: n }`, for the screens
// that must keep a custom exercise out of a shared routine (NATG-485): the routine editor, the
// Library's "Add to routine" and the finish summary's "Add it to …". Empty while sharing is
// unavailable, and until the store has the lists (it loads them as soon as sharing is available,
// useStore sharesIfAvailable). A hook beside the pure helpers rather than in components/, so
// sheets.jsx can use it without importing the routine page's Sharing section.
import { useStore } from '../store/useStore.js'
import { DEMO } from './demo.js'
import { sharingAvailable, sharesOf, shareCounts } from './shares.js'

export function useSharedCounts() {
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const shares = useStore(s => s.shares)
  return sharingAvailable(config, user, { demo: DEMO }) ? shareCounts(sharesOf(shares, user)?.outgoing) : {}
}
