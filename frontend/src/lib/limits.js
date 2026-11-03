// Upper bounds on the counts that drive a loop when a session's rows are built or a plan line is
// written (SEC-486-01). A routine shared with you is someone else's data: a sharer's "100,000,000
// sets" must not freeze your app, so a shared routine outside these bounds is not available
// (lib/shared-routines.js), and the builders clamp to them too, whatever the routine.
//
// The first two are the bounds the app already holds a logged workout to (log-workout.js
// LOG_LIMITS, which the MCP write tool enforces; shared-routines.test.js pins them together).
// The pyramid and triple-progression caps live where those rules do (pyramid.js
// MAX_PYRAMID_SETS, progression.js MAX_TRIPLE_SETS). The last two are new.
export const MAX_WORK_SETS = 50        // work sets of one exercise (LOG_LIMITS.maxSets)
export const MAX_BURST_REPS = 1000     // a rest-pause set's total reps (LOG_LIMITS.maxReps)
export const MAX_DROPS = 10            // drops on one drop set
export const MAX_ROUTINE_ROWS = 500    // rows a whole routine can start a session with

/** A whole number from 1 to `max`, or null: what a count driving a loop must be. */
export const boundedCount = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null)

/** `v` as a loop count from 1 to `max` (a builder's last line of defence). */
export const clampCount = (v, max) => Math.min(max, Math.max(1, Math.round(Number(v)) || 1))
