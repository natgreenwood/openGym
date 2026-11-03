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
import { MAX_PLANNED_WARMUPS } from './history.js'
import { MAX_WORK_SETS, MAX_BURST_REPS, MAX_DROPS, MAX_ROUTINE_ROWS, boundedCount } from './limits.js'
import { DEMO } from './demo.js'
import { isSharedId, sharedPointer, shareIdOf } from './routine-lookup.js'
import { sharesOf } from './shares.js'

// The server sends a shared routine's fields as the sharer stored them (api/shared-routine.js),
// checking type only where it turns a value into text. Everything else is the sharer's word, so
// each field is checked here for the type the app reads it as, and a value of another type is
// left out rather than rendered or computed with (SEC-01: never String() a value from a share).
const NUM = ['sets', 'min', 'speed', 'incline', 'sec', 'weight', 'reps', 'inc', 'deloadFactor', 'repsMin', 'setsMax', 'repsMax', 'restSec', 'warmupRestSec', 'sideRestSec', 'sgRest']
const BOOL = ['bodyweight', 'side', 'backoff', 'lastToFailure', 'restOff', 'warmupRestOff', 'sideRestOff']
const STR = ['id', 'mode', 'dbLoad', 'sg', 'sgName', 'note']
const ARR = ['pyramid', 'pyramidRest', 'pyramidWeight']
const OBJ = ['warmupSets', 'intensifier']
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const text = v => (typeof v === 'string' ? v : '')
/** A share's value as text: a string as it is, anything else empty. Never String() a share value. */
export const shareText = text

/**
 * Whether a shared routine's counts are ones this app can build rows from (SEC-486-01): every
 * count that drives a loop is a whole number within lib/limits.js, and the rows the whole routine
 * would start a session with stay within MAX_ROUTINE_ROWS. Judged on the routine as it came,
 * before anything is copied or built from it, so a sharer's "100,000,000 sets" costs nothing. A
 * routine outside them is not available, like one with a custom exercise: shown with the reason,
 * never started, its days kept.
 */
export function withinLimits(r) {
  const ex = Array.isArray(r?.ex) ? r.ex : []
  if (ex.length > MAX_ROUTINE_ROWS) return false
  let rows = 0
  for (const e of ex) {
    if (!isObj(e)) continue
    let sets = 1
    // 0 is "not set" (the editor's stepper starts there, and the builders read it as 1).
    if (e.sets !== undefined && e.sets !== 0) { sets = boundedCount(e.sets, MAX_WORK_SETS); if (sets == null) return false }
    if (e.setsMax != null && e.setsMax !== 0 && boundedCount(e.setsMax, MAX_TRIPLE_SETS) == null) return false
    for (const k of ARR) if (Array.isArray(e[k]) && e[k].length > MAX_PYRAMID_SETS) return false
    if (Array.isArray(e.pyramid) && e.pyramid.length > sets) sets = e.pyramid.length
    if (Array.isArray(e.warmupSets) && e.warmupSets.length > MAX_PLANNED_WARMUPS) return false
    const warm = typeof e.warmupSets === 'number' && e.warmupSets > 0 ? Math.min(MAX_PLANNED_WARMUPS, Math.round(e.warmupSets)) : 0
    let drops = 0
    const x = e.intensifier
    if (isObj(x) && x.type === 'dropset') { drops = boundedCount(x.count, MAX_DROPS); if (drops == null) return false }
    if (isObj(x) && x.type === 'restpause' && boundedCount(x.totalReps, MAX_BURST_REPS) == null) return false
    rows += (sets + warm) * (1 + drops)
    if (rows > MAX_ROUTINE_ROWS) return false
  }
  return true
}

function typedSlot(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !e.id) return null
  const out = {}
  for (const k of NUM) if (typeof e[k] === 'number' && Number.isFinite(e[k])) out[k] = e[k]
  for (const k of BOOL) if (typeof e[k] === 'boolean') out[k] = e[k]
  for (const k of STR) if (typeof e[k] === 'string') out[k] = e[k]
  // A pyramid step is a rep count or 'Max'; its rest and weight lists are numbers. The plan
  // import's normalisers below clamp the lengths and values.
  for (const k of ARR) if (Array.isArray(e[k])) out[k] = e[k].filter(x => (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'string')
  // Warm-up sets come as a number or a list of rows, an intensifier as an object; the plan
  // import's cleaners (cleanWarmupSets, cleanIntensifier) keep only a shape they know.
  for (const k of OBJ) if (isObj(e[k]) || Array.isArray(e[k]) || (typeof e[k] === 'number' && Number.isFinite(e[k]))) out[k] = e[k]
  if (typeof e.prog === 'string' && POLICIES.includes(e.prog)) out.prog = e.prog
  return out
}

// One projection per share version and unit: the hash moves only when what the share shows does
// (api/shared-routine.js contentHash), so the same answer converts once, not on every render.
const projected = new Map()

/**
 * The routine an accepted, usable incoming share holds, as this device trains it: its id is the
 * pointer (`shared:<shareId>`), its weights are converted from the sharer's unit to `toUnit`, and
 * it went through the plan import's normalisation (lib/plan-share.js parsePlan), so an odd
 * pyramid or back-off shape is handled where a shared plan file's is. An exercise this device
 * doesn't know, or one of your own custom exercises, is left out: a shared routine never holds a
 * custom exercise (NATG-483 AC11). Null for anything else: pending, not available, malformed.
 * `shared` says where it came from, for the read-only screens.
 */
export function sharedRoutineOf(item, toUnit = 'kg') {
  if (!isObj(item) || item.state !== 'accepted' || item.unavailable || !isObj(item.routine) || typeof item.id !== 'string' || !item.id) return null
  const to = toUnit === 'lb' ? 'lb' : 'kg'
  // The sharer's name is not in the hash (it isn't the routine's content): a rename of their
  // account must still reach "From …".
  const key = JSON.stringify([item.id, item.hash || '', to, text(item.from?.name)])
  if (projected.has(key)) return projected.get(key)
  const r = item.routine
  if (!withinLimits(r)) { projected.set(key, null); return null }
  const typed = {
    id: sharedPointer(item.id),
    name: text(r.name),
    ...(text(r.emoji) ? { emoji: text(r.emoji) } : {}),
    ...(typeof r.prog === 'string' && POLICIES.includes(r.prog) ? { prog: r.prog } : {}),
    ...(r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
    ex: (Array.isArray(r.ex) ? r.ex : []).map(typedSlot).filter(Boolean),
  }
  let out = null
  try {
    const from = item.unit === 'lb' ? 'lb' : 'kg'
    const bundle = parsePlan({ opengym_plan: 1, unit: from, routines: [typed] }, to)
    const got = bundle.routines[0]
    if (got) {
      out = {
        ...got,
        id: typed.id,
        ex: got.ex.filter(e => !isCustomEx(EXIDX[e.id])),
        shared: { id: item.id, from: { id: text(item.from?.id), name: text(item.from?.name) } },
      }
    }
  } catch { out = null }
  if (projected.size > 200) projected.clear()
  projected.set(key, out)
  return out
}

// Why an accepted share gives no routine: the server's reason, else too large (outside the limits),
// else unreadable (a shape nothing here can use).
const reasonOf = item => item.unavailable === 'custom-exercise' ? 'custom-exercise'
  : !item.unavailable && isObj(item.routine) && !withinLimits(item.routine) ? 'too-large' : 'unreadable'

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
    const r = sharedRoutineOf(item, unit)
    if (r) routines.push(r)
    else unavailable.push({ id: sharedPointer(item.id), item, name: shareNameOf(item) || text(mine.names?.[item.id]), reason: reasonOf(item), from: text(item.from?.name) })
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
