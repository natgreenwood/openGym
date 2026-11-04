// What the screens that keep a custom exercise out of a shared routine know about who has your
// routines (NATG-485, NATG-486): the routine editor, the Library's "Add to routine" and the finish
// summary's "Add it to …". A hook beside the pure helpers rather than in components/, so
// sheets.jsx can use it without importing the routine page's Sharing section. The store loads the
// lists as soon as sharing is available (useStore sharesIfAvailable) and keeps the last answer on
// this device, so the guard normally has a list to go by even offline.
import { useStore } from '../store/useStore.js'
import { DEMO } from './demo.js'
import { sharingAvailable, sharesOf, shareGuard } from './shares.js'

export function useShareGuard() {
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const shares = useStore(s => s.shares)
  const failed = useStore(s => s.sharesError)
  const mine = sharesOf(shares, user)
  // Until the config has loaded (a phone that starts offline has none), a list kept for this
  // account is proof sharing is on: it can't be switched off in v1, the rule the Shared tab
  // follows. A config the server did answer still decides.
  return shareGuard(sharingAvailable(config, user, { demo: DEMO }) || (config == null && !!mine), mine, failed)
}
