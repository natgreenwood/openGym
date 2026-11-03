// Routine sharing, the sharer's side (NATG-485): what the screens decide before they draw
// anything. The routes are the server's (api/server.js, "routine sharing"); this module only reads
// what they answer. Kept framework-free so each rule has a unit test beside it.
import { t } from './i18n-core.js'

/**
 * Whether any share action may appear at all. One check covers every case where sharing is
 * unavailable: the admin option is off (GET /api/config then has no `shares` key), nobody is
 * signed in (a guest, a phone in local mode, a signed-out browser) and the demo, which has no
 * server. A copy of the config fetched before an admin switched sharing on says no until the
 * next fetch, which is the safe side to be wrong on.
 */
export const sharingAvailable = (config, user, { demo = false } = {}) =>
  !demo && !!user && config?.shares === true

/**
 * The custom exercises in a routine, as the server judges them: an id that the profile's own
 * `customEx` lists (POST /api/shares answers `custom-exercise` for the same rule). Each one once,
 * in the routine's order.
 */
export function customExercisesIn(routine, S) {
  const custom = new Map((Array.isArray(S?.customEx) ? S.customEx : []).filter(c => c && c.id != null).map(c => [c.id, c]))
  const out = []
  for (const e of Array.isArray(routine?.ex) ? routine.ex : []) {
    const c = e && custom.get(e.id)
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

/** The store's share lists if they are this user's, else null (a sign-in as someone else). */
export const sharesOf = (shares, user) => (shares && user && shares.uid === user.id ? shares : null)

/** The people a routine is shared with: the outgoing items for it, by name. No state (epic AC12). */
export function sharedWith(outgoing, routineId) {
  return (Array.isArray(outgoing) ? outgoing : [])
    .filter(o => o && o.routineId === routineId && o.to && o.to.id)
    .sort((a, b) => String(a.to.name || '').localeCompare(String(b.to.name || '')) || (a.id < b.id ? -1 : 1))
}

/** How many routines each id is shared with, for the routines list ("Shared with 3"). */
export function shareCounts(outgoing) {
  const n = {}
  for (const o of Array.isArray(outgoing) ? outgoing : []) if (o && o.routineId) n[o.routineId] = (n[o.routineId] || 0) + 1
  return n
}

/** Up to two initials for the avatar: the first letters of the first two words. */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map(w => [...w][0].toUpperCase()).join('') || '?'
}

/** The picker's search: a case- and accent-blind match anywhere in the name. */
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
export function filterPeople(users, q) {
  const list = Array.isArray(users) ? users : []
  const needle = fold(q).trim()
  return needle ? list.filter(u => fold(u?.name).includes(needle)) : list
}

/**
 * What a failed POST /api/shares says to the sharer: `{ title, message, refresh }`. Creation is
 * all or nothing, so every failure can say that nobody got it. `refresh`: the people list is
 * out of date and is loaded again (someone picked has gone).
 *
 * `share-limit` names the shared-with list on purpose (NATG-484): a declined or removed share
 * keeps its place under the cap until the sharer unshares it, and the sharer cannot see which
 * ones those are, so the only way to make room is to unshare people there.
 */
export function shareError(e, routineName) {
  const code = e?.data?.code || e?.code
  const title = t('Couldn’t share {0}', routineName)
  switch (code) {
    case 'user-missing':
      return { title, message: t('Someone you picked is no longer on this server. The list is up to date now, so check who is picked and try again.'), refresh: true }
    case 'share-limit':
      return { title, message: t('You’ve reached the sharing limit on this server. People who turned a share down still count, so unshare anyone you no longer share with in the “Shared with” list of this or your other routines, then try again.') }
    case 'custom-exercise':
      return { title, message: t('It has a custom exercise, so it can’t be shared. Swap it for one from the library first.') }
    case 'routine-missing':
      return { title, message: t('This routine hasn’t reached the server yet. Wait a moment for it to sync, then try again.') }
    case 'sharing-off':
      return { title, message: t('Sharing isn’t switched on on this server.') }
  }
  if (e?.status === 429) return { title, message: t('You’ve shared a lot in the last hour. Try again later. Nobody got it yet.') }
  if (e?.status >= 500) return { title, message: t('The server couldn’t save it. Try again in a moment. Nobody got it yet.') }
  return { title, message: t('Check your connection and try again. Nobody got it yet.') }
}
