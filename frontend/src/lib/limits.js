// Upper bounds on the counts that drive a loop when a session's rows are built or a plan line is
// written (SEC-486-01). A routine shared with you is someone else's data: a sharer's "100,000,000
// sets" must not freeze your app, so a shared routine outside these bounds is not available
// (lib/shared-routines.js), and the builders clamp to them too, whatever the routine.
//
// The first two are the bounds the app already holds a logged workout to (log-workout.js
// LOG_LIMITS, which the MCP write tool enforces; shared-routines.limits.test.js pins them
// together). The pyramid cap lives where that rule does (pyramid.js MAX_PYRAMID_SETS); triple
// progression's ceiling moved here from progression.js (which re-exports it) so history.js can
// count rows with it without an import cycle. MAX_DROPS and MAX_ROUTINE_ROWS are new.
export const MAX_WORK_SETS = 50        // work sets of one exercise (LOG_LIMITS.maxSets)
export const MAX_TRIPLE_SETS = 10      // triple progression's set ceiling (was progression.js)
export const MAX_BURST_REPS = 1000     // a rest-pause set's total reps (LOG_LIMITS.maxReps)
export const MAX_DROPS = 10            // drops on one drop set
export const MAX_ROUTINE_ROWS = 500    // rows a routine, or a whole session, can be built with

// The longest text, in Unicode code points, the iPhone widget snapshot carries in one field
// (lib/widgets.js). A routine name, a shared one included, has no length limit of its own, and the
// widget extension reads the whole snapshot into memory (SEC-526-01).
export const MAX_WIDGET_TEXT = 200

/** A whole number from 1 to `max`, or null: what a count driving a loop must be. */
export const boundedCount = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null)

/** `v` as a loop count from 1 to `max` (a builder's last line of defence). */
export const clampCount = (v, max) => Math.min(max, Math.max(1, Math.round(Number(v)) || 1))
