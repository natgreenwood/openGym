// One way to find a routine by id, whether it is one of your own or one shared with you
// (routine sharing, NATG-486). A shared routine is never in `S.routines`: it lives in the
// sharer's document on the server, and this device holds it only in the store's `shares` slice
// (lib/shared-routines.js resolves it). Your own document points at it with the string
// `shared:<shareId>` wherever a routine id goes (week, dayPlan, the queue, a workout's rid).
//
// Kept apart from shared-routines.js on purpose: history.js, queue readers and session building
// import this, and it imports nothing, so no import cycle can form through the plan import.

export const SHARED_PREFIX = 'shared:'

/**
 * Whether `id` is a pointer to a shared routine. An exact, case-sensitive prefix match, the
 * server's own rule (api/server.js): `SHARED:x` or ` shared:x` are not pointers, and are looked
 * for among your own routines like any other id.
 */
export const isSharedId = id => typeof id === 'string' && id.startsWith(SHARED_PREFIX) && id.length > SHARED_PREFIX.length

/** The pointer your document stores for share `shareId`. */
export const sharedPointer = shareId => SHARED_PREFIX + shareId

/** The share id a pointer names, or null for anything that is not a pointer. */
export const shareIdOf = id => (isSharedId(id) ? id.slice(SHARED_PREFIX.length) : null)

/**
 * The routine `id` names: one of `S.routines`, or a usable shared routine from `shared` (the view
 * sharedViewOf builds). Undefined, as the `S.routines.find` it replaces answers, when nothing
 * usable answers to it: a deleted routine, a share that has ended, or one that is not available
 * right now. A `shared:` id is only ever looked up among the shared routines, so a routine of
 * your own that somehow carries such an id (the server strips them) can never stand in for one.
 */
export function routineById(S, id, shared = null) {
  if (id == null) return undefined
  if (isSharedId(id)) return shared?.byId?.get(id)
  return (Array.isArray(S?.routines) ? S.routines : []).find(r => r && r.id === id)
}

