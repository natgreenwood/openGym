// SEC-486-03: one boundary for share data. A sharer controls every field of a routine shared with
// you, and JSON can put an object, an array or text where the app reads a number. Every field the
// server lets through (api/shared-routine.js SLOT_FIELDS) is type-checked before anything reads
// it, and a share holding a value of the wrong type is not available ("can't be read"). Judging a
// share has one containment point: whatever it holds, only that share is affected, and a usable
// share beside it stays usable.
import { describe, expect, it } from 'vitest'
import { judgeRoutine, withinLimits, sharedRoutineOf, sharedView, shareOutcome, unavailableOf } from './shared-routines.js'
import { SLOT_FIELDS } from '../../../api/shared-routine.js'

const ME = { id: 'u2' }
const GOOD = { id: 'r1', name: 'Leg Day', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100 }] }
const slot = over => ({ id: '0025', sets: 3, reps: 5, weight: 100, ...over })
const accepted = (id, routine) => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h-' + id, routine })
// The bad share and a good one in the same list, both ways round.
const viewOf = bad => sharedView({ uid: 'u2', incoming: [accepted('good', GOOD), accepted('bad', bad), accepted('good2', { ...GOOD, name: 'Arm Day' })], outgoing: [], etag: 'e' }, ME, 'kg')

// The malformed values: the object from the SEC-486-03 report (Number() on it throws), a plain
// object, an array, and text.
const MALFORMED = [
  ['an object Number() throws on', { toString: 1 }],
  ['an object', { n: 3 }],
  ['an array', [3]],
  ['text', '3'],
]
// Every count: the slot's own, and the intensifiers'.
const COUNTS = ['sets', 'setsMax', 'warmupSets', 'reps', 'repsMin', 'repsMax', 'sec', 'min']
const INTENSIFIER = [
  ['intensifier.count', v => ({ type: 'dropset', count: v, pct: 20 })],
  ['intensifier.pct', v => ({ type: 'dropset', count: 2, pct: v })],
  ['intensifier.totalReps', v => ({ type: 'restpause', totalReps: v, restSec: 15 })],
  ['intensifier.restSec', v => ({ type: 'restpause', totalReps: 20, restSec: v })],
]
const cases = [
  ...COUNTS.flatMap(k => MALFORMED.map(([what, v]) => [`${k} as ${what}`, slot({ [k]: v })])),
  ...INTENSIFIER.flatMap(([k, make]) => MALFORMED.map(([what, v]) => [`${k} as ${what}`, slot({ intensifier: make(v) })])),
]

describe('a count of another type than a number', () => {
  it.each(cases)('%s: not available, and the share beside it stays usable', (_, bad) => {
    const r = { ...GOOD, ex: [slot(), bad] }
    expect(() => judgeRoutine(r)).not.toThrow()
    expect(judgeRoutine(r)).toBe('unreadable')
    expect(withinLimits(r)).toBe(false)
    expect(sharedRoutineOf(accepted('alone', r), 'kg')).toBeNull()
    const v = viewOf(r)
    expect(v.routines.map(x => x.id)).toEqual(['shared:good2', 'shared:good'])
    expect(v.ids.has('shared:bad')).toBe(false)
    expect(unavailableOf(v, 'shared:bad')).toMatchObject({ reason: 'unreadable', name: 'Leg Day' })
  })
})

describe('every other field the server lets through', () => {
  // The type each allowed slot field is read as; a value of any other type makes the share unreadable.
  const WRONG = {
    number: ['sets', 'min', 'speed', 'incline', 'sec', 'weight', 'reps', 'inc', 'deloadFactor', 'repsMin', 'setsMax', 'repsMax', 'restSec', 'warmupRestSec', 'sideRestSec', 'sgRest', 'warmupSets'],
    boolean: ['bodyweight', 'side', 'backoff', 'lastToFailure', 'restOff', 'warmupRestOff', 'sideRestOff'],
    string: ['mode', 'dbLoad', 'sg', 'sgName', 'note', 'prog'],
    list: ['pyramid', 'pyramidRest', 'pyramidWeight'],
    object: ['intensifier'],
  }
  it('covers the whole server allowlist', () => {
    expect(['id', ...Object.values(WRONG).flat()].sort()).toEqual([...SLOT_FIELDS].sort())
  })
  const wrongFor = type => ({ number: ['5', {}, [], true], boolean: ['yes', 1, {}, []], string: [5, {}, [], false], list: ['5', { 0: 5 }, 7, [{}], [[5]]], object: ['dropset', [], 3, true] })[type]
  const all = Object.entries(WRONG).flatMap(([type, keys]) => keys.flatMap(k => wrongFor(type).map(v => [k, JSON.stringify(v), v])))
  it.each(all)('%s = %s: not available, nothing thrown', (k, _, v) => {
    const r = { ...GOOD, ex: [slot({ [k]: v })] }
    expect(judgeRoutine(r)).toBe('unreadable')
    const out = viewOf(r)
    expect(out.routines).toHaveLength(2)
    expect(unavailableOf(out, 'shared:bad').reason).toBe('unreadable')
  })
  it('an id that is not text, and a slot that is not an object', () => {
    for (const ex of [[{ id: 12, sets: 3 }], [null], ['0025'], [[slot()]]]) expect(judgeRoutine({ ...GOOD, ex })).toBe('unreadable')
  })
  it('the routine’s own fields, and an exercise list that is not a list', () => {
    for (const over of [{ name: {} }, { emoji: 7 }, { prog: ['linear'] }, { excludeFromProgression: 'yes' }, { ex: { 0: slot() } }, { ex: 'Leg Day' }]) {
      expect(judgeRoutine({ ...GOOD, ...over })).toBe('unreadable')
    }
  })
  it('takes what the app itself writes: absent and null fields, a pyramid with Max, a known intensifier', () => {
    const r = { ...GOOD, prog: 'triple', excludeFromProgression: false, ex: [
      slot({ note: null, weight: null, side: false, warmupSets: 2, intensifier: { type: 'dropset', count: 2, pct: 20 } }),
      slot({ sets: 4, pyramid: [12, 10, 8, 'Max'], pyramidRest: [90, 90, 120], pyramidWeight: [40, 45, 50, 50] }),
      slot({ sets: 0, mode: 'time', sec: 30, side: true }),
      slot({ intensifier: { type: 'restpause', totalReps: 20, restSec: 15 } }),
    ] }
    expect(judgeRoutine(r)).toBe('ok')
    expect(sharedRoutineOf(accepted('fine', r), 'kg').ex).toHaveLength(4)
  })
})

describe('one containment point per share', () => {
  it('a share that throws while it is judged is only that share not being available', () => {
    const throwing = { name: 'Boom', get ex() { throw new Error('boom') } }
    expect(shareOutcome(accepted('bad', throwing), 'kg')).toEqual({ routine: null, reason: 'unreadable' })
    const v = viewOf(throwing)
    expect(v.routines.map(x => x.id)).toEqual(['shared:good2', 'shared:good'])
    expect(unavailableOf(v, 'shared:bad').reason).toBe('unreadable')
  })
  it('a share whose metadata throws is contained the same way', () => {
    const item = { ...accepted('bad', GOOD), get hash() { throw new Error('boom') } }
    expect(sharedRoutineOf(item, 'kg')).toBeNull()
    const v = sharedView({ uid: 'u2', incoming: [accepted('good', GOOD), item], outgoing: [], etag: 'e' }, ME, 'kg')
    expect(v.routines.map(x => x.id)).toEqual(['shared:good'])
    expect(unavailableOf(v, 'shared:bad').reason).toBe('unreadable')
  })
  it('a share that turns malformed after it was accepted is not available from the next answer on', () => {
    expect(sharedRoutineOf(accepted('later', GOOD), 'kg')).not.toBeNull()
    const edited = { ...accepted('later', { ...GOOD, ex: [slot({ warmupSets: { toString: 1 } })] }), hash: 'h-later-2' }
    expect(sharedRoutineOf(edited, 'kg')).toBeNull()
  })
})
