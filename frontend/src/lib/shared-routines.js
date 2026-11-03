// Routine sharing, the recipient's side (NATG-486): from what GET /api/shares answers to the
// routines this device can schedule and train. Pure and framework-free; the store keeps the
// answer (the `shares` slice, persisted as `gym_shared_v1`) and the screens read it through
// sharedViewOf. Nothing here is ever written into `S`: a shared routine lives in the sharer's
// document on the server, and your own document only points at it (`shared:<shareId>`,
// lib/routine-lookup.js).
import { parsePlan } from './plan-share.js'
import { EXIDX, isCustomEx } from './exercises.js'
import { POLICIES, MAX_TRIPLE_SETS } from './progression.js'
import { MAX_PYRAMID_SETS } from './pyramid.js'
import { routineRows } from './history.js'
import { MAX_WORK_SETS, MAX_BURST_REPS, MAX_DROPS, MAX_ROUTINE_ROWS, boundedCount } from './limits.js'
import { DEMO } from './demo.js'
import { isSharedId, sharedPointer, shareIdOf } from './routine-lookup.js'
import { sharesOf } from './shares.js'

// The server sends a shared routine's fields as the sharer stored them (api/shared-routine.js),
// checking type only where it turns a value into text. Everything else is the sharer's word, so
// each field is checked here for the type the app reads it as (slotWellTyped), and a share holding
// a value of another type is not available: nothing renders or computes with it (SEC-01: never
// String() a value from a share; SEC-486-03: never Number() one either).
const NUM = ['sets', 'min', 'speed', 'incline', 'sec', 'weight', 'reps', 'inc', 'deloadFactor', 'repsMin', 'setsMax', 'repsMax', 'restSec', 'warmupRestSec', 'sideRestSec', 'sgRest']
const BOOL = ['bodyweight', 'side', 'backoff', 'lastToFailure', 'restOff', 'warmupRestOff', 'sideRestOff']
const STR = ['id', 'mode', 'dbLoad', 'sg', 'sgName', 'note']
const ARR = ['pyramid', 'pyramidRest', 'pyramidWeight']
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const text = v => (typeof v === 'string' ? v : '')
/** A share's value as text: a string as it is, anything else empty. Never String() a share value. */
export const shareText = text

const isNum = v => typeof v === 'number' && Number.isFinite(v)
// Absent, as the plan export leaves it, or null, as JSON keeps a cleared field: either is "not
// set", and no reader goes past `?.` or `!= null` with it.
const unset = v => v === undefined || v === null
const INTENSIFIER_NUM = ['count', 'pct', 'totalReps', 'restSec']
// A pyramid step is a rep count or 'Max'; its rest and weight lists are numbers.
const stepOk = x => isNum(x) || typeof x === 'string'

/**
 * Whether every field a shared slot can carry (the server's allowlist, api/shared-routine.js
 * SLOT_FIELDS) is the primitive the app reads it as (SEC-486-03). This is the one boundary for
 * share data: nothing reads a slot's counts, warm-ups, intensifier or progression fields before
 * it has passed, so no `Number()` or `.length` ever runs on an object, an array or text a sharer
 * put where a number goes. A list longer than its limit is not walked here; judgeRoutine rejects
 * it on its length.
 */
function slotWellTyped(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !e.id) return false
  for (const k of NUM) if (!unset(e[k]) && !isNum(e[k])) return false
  if (!unset(e.warmupSets) && !isNum(e.warmupSets)) return false
  for (const k of BOOL) if (!unset(e[k]) && typeof e[k] !== 'boolean') return false
  for (const k of STR) if (!unset(e[k]) && typeof e[k] !== 'string') return false
  if (!unset(e.prog) && typeof e.prog !== 'string') return false
  for (const k of ARR) {
    const v = e[k]
    if (unset(v)) continue
    if (!Array.isArray(v)) return false
    if (v.length <= MAX_PYRAMID_SETS && !v.every(stepOk)) return false
  }
  const x = e.intensifier
  if (!unset(x)) {
    if (!isObj(x) || (!unset(x.type) && typeof x.type !== 'string')) return false
    for (const k of INTENSIFIER_NUM) if (!unset(x[k]) && !isNum(x[k])) return false
  }
  return true
}

/**
 * What a shared routine is, judged on it as it came and before anything is copied or built from
 * it: 'ok', 'unreadable' (a field that is not the primitive the app reads it as, SEC-486-03) or
 * 'too-large' (a count outside lib/limits.js, or more rows than MAX_ROUTINE_ROWS, SEC-486-01).
 * The order matters: a list too long to walk is turned away on its length, then every field's
 * type is checked, and only then are counts read, so nothing here can throw on a sharer's data.
 */
export function judgeRoutine(r) {
  if (!isObj(r)) return 'unreadable'
  if (!unset(r.ex) && !Array.isArray(r.ex)) return 'unreadable'
  const ex = r.ex || []
  if (ex.length > MAX_ROUTINE_ROWS) return 'too-large'
  if (typeof r.name !== 'string' && !unset(r.name)) return 'unreadable'
  if (!unset(r.emoji) && typeof r.emoji !== 'string') return 'unreadable'
  if (!unset(r.prog) && typeof r.prog !== 'string') return 'unreadable'
  if (!unset(r.excludeFromProgression) && typeof r.excludeFromProgression !== 'boolean') return 'unreadable'
  for (const k of ARR) for (const e of ex) if (isObj(e) && Array.isArray(e[k]) && e[k].length > MAX_PYRAMID_SETS) return 'too-large'
  if (!ex.every(slotWellTyped)) return 'unreadable'
  // Each count that drives a loop, strictly: a whole number within its limit.
  for (const e of ex) {
    // 0 is "not set" (the editor's stepper starts there, and the builders read it as 1).
    if (!unset(e.sets) && e.sets !== 0 && boundedCount(e.sets, MAX_WORK_SETS) == null) return 'too-large'
    if (!unset(e.setsMax) && e.setsMax !== 0 && boundedCount(e.setsMax, MAX_TRIPLE_SETS) == null) return 'too-large'
    const x = e.intensifier
    if (isObj(x) && x.type === 'dropset' && boundedCount(x.count, MAX_DROPS) == null) return 'too-large'
    if (isObj(x) && x.type === 'restpause' && boundedCount(x.totalReps, MAX_BURST_REPS) == null) return 'too-large'
  }
  // Then the rows the builders would generate, counted the way they count them (rowPlan): per-
  // side work twice, warm-ups, drops and bursts, a triple progression's ceiling.
  return routineRows(r) <= MAX_ROUTINE_ROWS ? 'ok' : 'too-large'
}

/**
 * Whether a shared routine is one this app can build rows from (SEC-486-01, SEC-486-03): every
 * field the type the app reads it as, every count that drives a loop a whole number within
 * lib/limits.js, and the rows the whole routine would start a session with within
 * MAX_ROUTINE_ROWS. A routine that isn't is not available, like one with a custom exercise: shown
 * with the reason, never started, its days kept.
 */
export const withinLimits = r => judgeRoutine(r) === 'ok'

function typedSlot(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !e.id) return null
  const out = {}
  for (const k of NUM) if (typeof e[k] === 'number' && Number.isFinite(e[k])) out[k] = e[k]
  for (const k of BOOL) if (typeof e[k] === 'boolean') out[k] = e[k]
  for (const k of STR) if (typeof e[k] === 'string') out[k] = e[k]
  // A pyramid step is a rep count or 'Max'; its rest and weight lists are numbers. The plan
  // import's normalisers below clamp the lengths and values.
  for (const k of ARR) if (Array.isArray(e[k])) out[k] = e[k].filter(x => (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'string')
  // Warm-up sets come as a number, an intensifier as an object (slotWellTyped checked both); the
  // plan import's cleaners (cleanWarmupSets, cleanIntensifier) keep only a shape they know.
  if (isNum(e.warmupSets)) out.warmupSets = e.warmupSets
  if (isObj(e.intensifier)) out.intensifier = e.intensifier
  if (typeof e.prog === 'string' && POLICIES.includes(e.prog)) out.prog = e.prog
  return out
}

// One answer per share version and unit: the hash moves only when what the share shows does
// (api/shared-routine.js contentHash), so the same answer is judged and converted once, not on
// every render.
const projected = new Map()
const UNREADABLE = Object.freeze({ routine: null, reason: 'unreadable' })

// The routine an accepted share holds, judged and projected; may throw on data no check foresaw,
// which is why the only caller is shareOutcome.
function evaluateShare(item, toUnit) {
  if (!isObj(item) || typeof item.id !== 'string' || !item.id || item.state !== 'accepted') return UNREADABLE
  if (item.unavailable === 'custom-exercise') return { routine: null, reason: 'custom-exercise' }
  if (item.unavailable || !isObj(item.routine)) return UNREADABLE
  const to = toUnit === 'lb' ? 'lb' : 'kg'
  // The sharer's name is not in the hash (it isn't the routine's content): a rename of their
  // account must still reach "From …".
  const key = JSON.stringify([item.id, item.hash || '', to, text(item.from?.name)])
  if (projected.has(key)) return projected.get(key)
  const r = item.routine
  const verdict = judgeRoutine(r)
  let out = UNREADABLE
  if (verdict !== 'ok') out = { routine: null, reason: verdict }
  else {
    const typed = {
      id: sharedPointer(item.id),
      name: text(r.name),
      ...(text(r.emoji) ? { emoji: text(r.emoji) } : {}),
      ...(typeof r.prog === 'string' && POLICIES.includes(r.prog) ? { prog: r.prog } : {}),
      ...(r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
      ex: (r.ex || []).map(typedSlot).filter(Boolean),
    }
    const from = item.unit === 'lb' ? 'lb' : 'kg'
    const got = parsePlan({ opengym_plan: 1, unit: from, routines: [typed] }, to).routines[0]
    if (got) {
      out = { routine: {
        ...got,
        id: typed.id,
        ex: got.ex.filter(e => !isCustomEx(EXIDX[e.id])),
        shared: { id: item.id, from: { id: text(item.from?.id), name: text(item.from?.name) } },
      }, reason: null }
    }
  }
  if (projected.size > 200) projected.clear()
  projected.set(key, out)
  return out
}

/**
 * Everything about one incoming share that decides whether it can be trained: `{ routine,
 * reason }`, the routine when it is usable, else null and why not ('custom-exercise', 'too-large'
 * or 'unreadable'). The one containment point per share (SEC-486-03): whatever a share holds,
 * judging it can't throw past here, so a malformed share is only that share not being available,
 * never the Shared tab, the schedule or another share failing with it.
 */
export function shareOutcome(item, toUnit = 'kg') {
  try { return evaluateShare(item, toUnit) } catch { return UNREADABLE }
}

/**
 * The routine an accepted, usable incoming share holds, as this device trains it: its id is the
 * pointer (`shared:<shareId>`), its weights are converted from the sharer's unit to `toUnit`, and
 * it went through the plan import's normalisation (lib/plan-share.js parsePlan), so an odd
 * pyramid or back-off shape is handled where a shared plan file's is. An exercise this device
 * doesn't know, or one of your own custom exercises, is left out: a shared routine never holds a
 * custom exercise (NATG-483 AC11). Null for anything else: pending, not available, malformed.
 * `shared` says where it came from, for the read-only screens.
 */
export const sharedRoutineOf = (item, toUnit = 'kg') => shareOutcome(item, toUnit).routine

const EMPTY = Object.freeze({ routines: [], byId: new Map(), ids: new Set(), pending: [], unavailable: [], items: [], fetchedAt: 0, known: false })

/**
 * Everything the screens need about the routines shared with you, from the store's `shares`
 * slice: `routines` (accepted and usable, by name), `byId` and `ids` (their pointers, for
 * routineById and the plan readers' `extraIds`), `pending` (waiting for an answer), `unavailable`
 * (accepted but not usable right now, each with its pointer and reason) and `fetchedAt` (the
 * last successful load). Empty for a list that is someone else's (a sign-in as another account)
 * and in the demo. It does not ask whether sharing is switched on: a phone that starts offline
 * has no config yet, and its shared routines must still be there at their last-synced version.
 */
export function sharedView(shares, user, unit = 'kg') {
  const mine = DEMO ? null : sharesOf(shares, user)
  if (!mine) return EMPTY
  const items = (Array.isArray(mine.incoming) ? mine.incoming : []).filter(i => isObj(i) && typeof i.id === 'string' && i.id)
  const routines = [], unavailable = [], pending = []
  for (const item of items) {
    if (item.state === 'pending') { pending.push(item); continue }
    if (item.state !== 'accepted') continue
    const { routine, reason } = shareOutcome(item, unit)
    if (routine) routines.push(routine)
    else unavailable.push({ id: sharedPointer(item.id), item, name: shareNameOf(item) || text(mine.names?.[item.id]), reason, from: text(item.from?.name) })
  }
  const byName = (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)
  routines.sort(byName)
  return {
    routines,
    byId: new Map(routines.map(r => [r.id, r])),
    ids: new Set(routines.map(r => r.id)),
    pending,
    unavailable,
    items,
    fetchedAt: Number(mine.fetchedAt) || 0,
    known: true,
  }
}

// The view for the store's current state, the same object for the same inputs: a selector must
// answer the same thing twice in a row or React renders forever (zustand's useSyncExternalStore).
let last = { shares: undefined, uid: undefined, unit: undefined, view: EMPTY }
export function sharedViewOf(state) {
  const shares = state?.shares ?? null
  const uid = state?.user?.id ?? null
  const unit = state?.S?.unit === 'lb' ? 'lb' : 'kg'
  if (last.shares === shares && last.uid === uid && last.unit === unit) return last.view
  const view = sharedView(shares, state?.user ?? null, unit)
  last = { shares, uid, unit, view }
  return view
}

/** The not-available entry a pointer names, or null. */
export const unavailableOf = (shared, id) => (shared?.unavailable || []).find(u => u.id === id) ?? null

/**
 * The `shared:` pointers in your own document whose share is gone from `incoming` altogether:
 * removed, revoked, declined, or its routine deleted. A share that is not available right now is
 * still listed (it comes back when it heals), so its pointers stay. Re-sharing never reopens a
 * share (NATG-484): a pointer that stopped resolving never resolves again, so these only ever
 * need removing. Looked for where deleteRoutine looks (week, dayPlan).
 */
export function orphanPointers(S, incoming) {
  const live = new Set((Array.isArray(incoming) ? incoming : []).filter(isObj).map(i => i.id))
  const found = new Set()
  const see = id => { if (isSharedId(id) && !live.has(shareIdOf(id))) found.add(id) }
  for (const v of Object.values(S?.week || {})) [].concat(v).forEach(see)
  for (const v of Object.values(S?.dayPlan || {})) see(v)
  return [...found]
}

/** The name a share shows: its routine's once accepted, its preview's while pending. */
export const shareNameOf = item => text(item?.routine?.name) || text(item?.preview?.name)

/**
 * `{ shareId: name }` for every share in `incoming`: the name it shows now, or the one it showed
 * last (`prev`) when it comes without one (not available right now). Names of shares no longer
 * listed are dropped. Only names: the routine itself is never kept for a share that is not
 * available (NATG-487 settled point 1).
 */
export function sharedNames(incoming, prev = null) {
  const out = {}
  for (const i of Array.isArray(incoming) ? incoming : []) {
    if (!isObj(i) || typeof i.id !== 'string') continue
    const name = shareNameOf(i) || text(prev?.[i.id])
    if (name) out[i.id] = name
  }
  return out
}
