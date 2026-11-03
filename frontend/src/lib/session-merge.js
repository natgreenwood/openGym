// Building one session's entries from more than one routine (the "combine routines" feature).
//
// A combined session is just the concatenation of the entries each routine would have built on
// its own, with `entry.rid` stamped so a saved workout can be read back per routine. There is
// no composite-routine object: nothing is stored that a single-routine session did not already
// store, only widened. Every start path routes through here, including a single-routine start
// (a one-element list) and freestyle (an empty list → no entries, no rid).
//
// Imported only by sheets.jsx and views/Workout.jsx; imports session-start.js (which pulls in
// history.js + progression.js). Nothing in that chain imports this file, so there is no cycle.
import { buildSessionEntries } from './session-start.js'
import { routineById } from './routine-lookup.js'
import { routineRows } from './history.js'
import { isSideSet } from './workout-model.js'
import { MAX_ROUTINE_ROWS } from './limits.js'

// The drops and rest-pause bursts one row (or one side of a per-side row) carries.
const extrasOf = x => (Array.isArray(x?.drops) ? x.drops.length : 0) + (Array.isArray(x?.clusters) ? x.clusters.length : 0)

/**
 * The rows a session's entries hold, counted the way history.js rowPlan counts a routine's
 * (SEC-486-01): a plain row and each of its drops or bursts is one; a per-side row is its two
 * sides, each one row plus that side's own drops or bursts. The parent of a per-side row is not
 * counted as well: it is only the two sides' aggregate (workout-model.js syncSideAggregate),
 * which keeps no drops or bursts of its own.
 */
export function sessionRows(entries) {
  let n = 0
  for (const e of Array.isArray(entries) ? entries : []) {
    for (const s of Array.isArray(e?.sets) ? e.sets : []) {
      n += isSideSet(s) ? 2 + extrasOf(s.sides.L) + extrasOf(s.sides.R) : 1 + extrasOf(s)
    }
  }
  return n
}

/**
 * Whether routines with these rows still fit a session that already holds `entries`: one session
 * is held to MAX_ROUTINE_ROWS however its routines come together, combined at the start or added
 * one by one (SEC-486-01). Judged from the routines' plans, before a row is built.
 */
export const fitsSession = (routines, entries = []) =>
  sessionRows(entries) + routines.reduce((n, r) => n + routineRows(r), 0) <= MAX_ROUTINE_ROWS

/**
 * Build a session's entries from an ordered list of routine ids.
 * - resolves + filters to still-existing routines, de-duplicates by id (first wins); `shared`
 *   (optional, lib/shared-routines.js sharedViewOf) resolves the routines shared with you too
 * - concatenates each routine's entries in list order
 * - stamps `entry.rid` = that routine's id on every entry
 *
 * Returns `{ entries, routineIds, routines }` — `routineIds` / `routines` are the resolved,
 * de-duplicated list, so a caller stores exactly what was built. Routines that together would
 * build more than MAX_ROUTINE_ROWS rows build nothing: `{ entries: [], routineIds: [], routines:
 * [], tooLarge: true }`, decided before any row is built, never a cut-down copy (SEC-486-01). A
 * caller must not start that as a freestyle session.
 */
/** The routines a list of ids starts a session with: resolved, existing, each once (first wins). */
export function sessionRoutines(st, routineIds, shared = null) {
  const seen = new Set()
  return [].concat(routineIds ?? [])
    .filter(id => id && !seen.has(id) && seen.add(id))
    // A routine shared with you (`shared:<id>`) starts like one of your own, from the version
    // this device last synced. The entries are a snapshot: a later edit by the sharer changes
    // the next session, never the one already running (NATG-486 AC8).
    .map(id => routineById(st, id, shared))
    .filter(Boolean)
}

export function buildCombinedEntries(st, routineIds, shared = null) {
  const routines = sessionRoutines(st, routineIds, shared)
  if (!fitsSession(routines)) return { entries: [], routineIds: [], routines: [], tooLarge: true }
  const entries = routines.flatMap(r =>
    buildSessionEntries(st, r).map(e => ({ ...e, rid: r.id }))
  )
  return { entries, routineIds: routines.map(r => r.id), routines }
}

/**
 * The session name for a combined workout, from routine names in merge order (ENG-12 rule):
 *   1–3 routines → join with " + "          → "Rehab + Core"
 *   4+ routines  → first two, then "+ N more" → "Rehab + Core + 2 more"
 * An empty list returns null — not a reachable state for a saved or active session.
 */
export function deriveSessionName(names) {
  if (!names.length) return null
  if (names.length <= 3) return names.join(' + ')
  return `${names[0]} + ${names[1]} + ${names.length - 2} more`
}
