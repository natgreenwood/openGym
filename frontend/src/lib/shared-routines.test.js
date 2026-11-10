// NATG-486: the recipient's side of routine sharing, pure. One resolver for own and shared
// routine ids (an exact `shared:` prefix), the incoming routine as this device trains it (the
// recipient's unit, the plan import's normalisation, typed fields), the view the screens read, and
// the pointer clean-up that only ever removes.
import { describe, expect, it } from 'vitest'
import { isSharedId, sharedPointer, shareIdOf, routineById, SHARED_PREFIX } from './routine-lookup.js'
import { sharedRoutineOf, shareOutcome, sharedView, sharedViewOf, orphanPointers, sharedNames, unavailableOf } from './shared-routines.js'
import { registerCustom } from './exercises.js'

const ME = { id: 'u2', name: 'Jo Patel' }
// The hash covers the unit and the routine, as the server's does (api/server.js contentHash): the
// module keeps one projection per id and hash, so two fixtures that differ in either need two
// hashes, or the second test to run reads the first one's projection back.
const accepted = (id, routine, extra = {}) => ({
  id, state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, created: '2026-11-03T00:00:00Z', acceptedAt: '2026-11-03T00:00:00Z',
  unit: 'kg', hash: 'h-' + JSON.stringify([extra.unit || 'kg', routine]), routine, ...extra,
})
const LEG = { id: 'r1', name: 'Leg Day', emoji: 'barbell', prog: 'linear', ex: [{ id: '0025', sets: 5, reps: 5, weight: 100 }, { id: '0007', sets: 3, reps: 10, weight: 40 }] }
const lists = (incoming, extra = {}) => ({ uid: ME.id, incoming, outgoing: [], etag: 'e1', fetchedAt: 1000, ...extra })

describe('isSharedId: the exact prefix the server uses', () => {
  it('takes `shared:<id>` and nothing that merely looks like it', () => {
    expect(isSharedId('shared:3f9c2a7d1e4b8c60')).toBe(true)
    expect(isSharedId('SHARED:3f9c2a7d1e4b8c60')).toBe(false)
    expect(isSharedId(' shared:3f9c2a7d1e4b8c60')).toBe(false)
    expect(isSharedId('xshared:abc')).toBe(false)
    expect(isSharedId(SHARED_PREFIX)).toBe(false)
    expect(isSharedId(null)).toBe(false)
    expect(isSharedId(42)).toBe(false)
  })
  it('builds and reads a pointer', () => {
    expect(sharedPointer('abc')).toBe('shared:abc')
    expect(shareIdOf('shared:abc')).toBe('abc')
    expect(shareIdOf('r1')).toBeNull()
  })
})

describe('routineById: own and shared alike', () => {
  const S = { routines: [{ id: 'r1', name: 'Mine' }, { id: 'shared:s1', name: 'Smuggled' }, { id: 'SHARED:s1', name: 'Odd own id' }] }
  const shared = sharedView(lists([accepted('s1', LEG)]), ME, 'kg')
  it('finds your own routine by its id', () => {
    expect(routineById(S, 'r1', shared).name).toBe('Mine')
  })
  it('finds a usable shared routine by its pointer', () => {
    expect(routineById(S, 'shared:s1', shared).name).toBe('Leg Day')
  })
  it('never lets one of your own routines stand in for a pointer, even one carrying its id', () => {
    expect(routineById(S, 'shared:s1', null)).toBeUndefined()
    expect(routineById(S, 'shared:s1', shared).name).toBe('Leg Day')
  })
  it('looks a near-miss id up among your own routines, as the server does', () => {
    expect(routineById(S, 'SHARED:s1', shared).name).toBe('Odd own id')
  })
  it('answers undefined for an id nothing answers to, as Array.find did', () => {
    expect(routineById(S, 'gone', shared)).toBeUndefined()
    expect(routineById(S, 'shared:gone', shared)).toBeUndefined()
    expect(routineById(S, null, shared)).toBeUndefined()
  })
})

describe('sharedRoutineOf: the routine as this device trains it', () => {
  it('is addressed by its pointer and says who it is from', () => {
    const r = sharedRoutineOf(accepted('s1', LEG), 'kg')
    expect(r.id).toBe('shared:s1')
    expect(r.shared).toEqual({ id: 's1', from: { id: 'u1', name: 'Sam Keller' } })
    expect(r.ex.map(e => e.id)).toEqual(['0025', '0007'])
  })
  it('converts the sharer’s weights into the recipient’s unit (AC7)', () => {
    const r = sharedRoutineOf(accepted('s1', LEG), 'lb')
    expect(r.ex[0].weight).toBe(220.5)
    expect(r.ex[1].weight).toBe(88)
    // Already in the right unit: nothing moves.
    expect(sharedRoutineOf(accepted('s2', LEG, { unit: 'lb' }), 'lb').ex[0].weight).toBe(100)
  })
  it('keeps a known progression rule only, and an exercise’s fields as they came (SEC-01)', () => {
    const r = sharedRoutineOf(accepted('s3', { ...LEG, prog: 'nonsense', ex: [{ id: '0025', reps: 5, weight: 100, note: 'slow down', side: true }] }), 'kg')
    expect(r.prog).toBeUndefined()
    expect(r.ex).toHaveLength(1)
    expect(r.ex[0].sets).toBeUndefined()
    expect(r.ex[0].note).toBe('slow down')
    expect(r.ex[0].reps).toBe(5)
  })
  // NATG-540: a shared slot goes through the plan import's slot cleaner (cleanSlot) and nothing
  // else, so these pin what the share boundary did before that and must still do.
  it('keeps an exercise’s own progression rule only when the app knows it', () => {
    const r = sharedRoutineOf(accepted('s9', { ...LEG, ex: [
      { id: '0025', sets: 3, reps: 5, prog: 'double' },
      { id: '0007', sets: 3, reps: 5, prog: 'nonsense' },
      { id: '0007', sets: 3, reps: 5, prog: 'constructor' },
    ] }), 'kg')
    expect(r.ex.map(e => e.prog)).toEqual(['double', undefined, undefined])
    expect(r.ex.every(e => Object.hasOwn(e, 'prog') === (e.prog === 'double'))).toBe(true)
  })
  it('gives no routine for a pyramid holding a step that is neither a number nor text', () => {
    for (const [k, list] of [['pyramid', [12, {}, 8]], ['pyramid', [12, [8], 6]], ['pyramid', [12, true, 8]], ['pyramidRest', [90, null, 90]], ['pyramidWeight', [40, { n: 1 }, 50]]]) {
      const ex = [{ id: '0025', sets: 3, pyramid: [12, 10, 8], [k]: list }]
      expect(sharedRoutineOf(accepted('pyr-' + k + JSON.stringify(list), { ...LEG, ex }), 'kg'), `${k} ${JSON.stringify(list)}`).toBeNull()
    }
  })
  it('gives no routine for a count sent as numeric text, rather than reading "3" as 3', () => {
    // judgeRoutine turns these away, which is why the share path can use a cleaner that coerces
    // numeric text for a hand-edited plan file.
    for (const k of ['sets', 'reps', 'weight', 'restSec', 'warmupSets', 'setsMax', 'repsMax']) {
      const ex = [{ id: '0025', sets: 3, reps: 5, weight: 100, [k]: '3' }]
      expect(sharedRoutineOf(accepted('text-' + k, { ...LEG, ex }), 'kg'), k).toBeNull()
    }
  })
  it('keeps a pyramid of numbers and max exactly as the plan import normalises it', () => {
    const ex = [{ id: '0025', sets: 4, pyramid: [12, 10, 8, 'max'], pyramidRest: [90, 90, 120], pyramidWeight: [40, 45, 50, 50] }]
    expect(sharedRoutineOf(accepted('pyr-ok', { ...LEG, ex }), 'kg').ex[0]).toMatchObject({
      pyramid: [12, 10, 8, 'max'], pyramidRest: [90, 90, 120, 0], pyramidWeight: [40, 45, 50, 50],
    })
  })
  it('gives no routine for a share holding a value of another type than the app reads (SEC-486-03)', () => {
    // Before SEC-486-03 these were left out one by one and the rest trained; now a share that
    // holds one is not available, so no code ever reads a value of the wrong type from a share.
    const odd = [
      { ...LEG, name: { toString: 1 } },
      { ...LEG, emoji: 7 },
      { ...LEG, ex: [{ id: '0025', reps: 5, weight: 100, note: { evil: true } }] },
      { ...LEG, ex: [{ id: '0025', reps: 5, weight: 100, side: 'yes' }] },
      { ...LEG, ex: [{ id: '0025', sets: 3 }, { id: 12 }] },
      { ...LEG, ex: [{ id: '0025', sets: 3 }, null] },
    ]
    odd.forEach((r, i) => expect(sharedRoutineOf(accepted('odd' + i, r), 'kg')).toBeNull())
  })
  it('leaves out an exercise this device doesn’t know, and any of the recipient’s own custom ones', () => {
    registerCustom([{ id: 'cx-mine', n: 'My own move', custom: true, bp: 'back', tg: 'lats', eq: 'cable', sm: [], st: [] }])
    const r = sharedRoutineOf(accepted('s4', { ...LEG, ex: [{ id: 'nope-123', sets: 3 }, { id: 'cx-mine', sets: 3 }, { id: '0025', sets: 3 }] }), 'kg')
    expect(r.ex.map(e => e.id)).toEqual(['0025'])
  })
  it('follows a rename of the sharer’s account, which doesn’t move the routine’s hash', () => {
    expect(sharedRoutineOf(accepted('s8', LEG), 'kg').shared.from.name).toBe('Sam Keller')
    expect(sharedRoutineOf(accepted('s8', LEG, { from: { id: 'u1', name: 'Sam K.' } }), 'kg').shared.from.name).toBe('Sam K.')
  })
  it('is null for anything that is not an accepted, usable share', () => {
    expect(sharedRoutineOf({ id: 's5', state: 'pending', preview: { name: 'Leg Day', exercises: 2 } })).toBeNull()
    expect(sharedRoutineOf({ id: 's6', state: 'accepted', unavailable: 'custom-exercise' })).toBeNull()
    expect(sharedRoutineOf({ id: 's7', state: 'accepted', routine: 'not an object' })).toBeNull()
    expect(sharedRoutineOf(null)).toBeNull()
  })
})

describe('sharedView: what the screens read', () => {
  const incoming = [
    accepted('s1', LEG),
    accepted('s2', { ...LEG, id: 'r2', name: 'Arm Day' }),
    { id: 's3', state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unavailable: 'custom-exercise' },
    { id: 's4', state: 'pending', from: { id: 'u3', name: 'Alex' }, hash: 'p', preview: { name: 'Mobility', exercises: 8 } },
    { id: 's5', state: 'pending', from: { id: 'u3', name: 'Alex' }, unavailable: 'unreadable' },
  ]
  const v = sharedView(lists(incoming, { names: { s3: 'Push Day' } }), ME, 'kg')
  it('sorts the usable routines by name, and indexes them by pointer', () => {
    expect(v.routines.map(r => r.name)).toEqual(['Arm Day', 'Leg Day'])
    expect([...v.ids]).toEqual(['shared:s2', 'shared:s1'])
    expect(v.byId.get('shared:s1').name).toBe('Leg Day')
  })
  it('never offers a pending share as a usable routine (AC2)', () => {
    expect(v.ids.has('shared:s4')).toBe(false)
    expect(v.pending.map(p => p.id)).toEqual(['s4', 's5'])
  })
  it('lists a share that is not available with its reason and its last known name (AC9)', () => {
    expect(v.ids.has('shared:s3')).toBe(false)
    expect(unavailableOf(v, 'shared:s3')).toMatchObject({ reason: 'custom-exercise', name: 'Push Day', from: 'Sam Keller' })
  })
  it('is empty for lists that belong to another account', () => {
    const other = sharedView(lists(incoming), { id: 'u9' }, 'kg')
    expect(other.known).toBe(false)
    expect(other.routines).toEqual([])
  })
  it('hands back the same object for the same store state, so a selector settles', () => {
    const state = { shares: lists(incoming), user: ME, S: { unit: 'kg' } }
    expect(sharedViewOf(state)).toBe(sharedViewOf({ ...state }))
    expect(sharedViewOf({ ...state, S: { unit: 'lb' } })).not.toBe(sharedViewOf(state))
  })
})

describe('the server’s reason a share is not available (NATG-659)', () => {
  const off = (id, unavailable) => ({ id, state: 'accepted', from: { id: 'u1', name: 'Sam Keller' }, unavailable })
  it('keeps too-large: a share over the server’s size cap says so, not that it can’t be read', () => {
    expect(shareOutcome(off('s1', 'too-large'))).toEqual({ routine: null, reason: 'too-large' })
    // Even with a routine beside it: the server's verdict wins over judging the routine here.
    expect(shareOutcome({ ...accepted('s1', LEG), unavailable: 'too-large' })).toEqual({ routine: null, reason: 'too-large' })
    const v = sharedView(lists([off('s1', 'too-large')], { names: { s1: 'Leg Day' } }), ME, 'kg')
    expect(unavailableOf(v, 'shared:s1')).toMatchObject({ reason: 'too-large', name: 'Leg Day', from: 'Sam Keller' })
  })
  it('keeps custom-exercise as before', () => {
    expect(shareOutcome(off('s2', 'custom-exercise'))).toEqual({ routine: null, reason: 'custom-exercise' })
  })
  it('reads any other reason, or one it doesn’t know, as unreadable, never passing the server’s word through', () => {
    for (const reason of ['unreadable', 'gone', 'Too-Large', 'too-large ', 'custom-exercise-x', 1, true, { reason: 'too-large' }, ['too-large']]) {
      expect(shareOutcome(off('s3', reason))).toEqual({ routine: null, reason: 'unreadable' })
    }
  })
  it('leaves a pending share that is too large waiting, not listed as not available', () => {
    const v = sharedView(lists([{ id: 's4', state: 'pending', from: { id: 'u3', name: 'Alex' }, unavailable: 'too-large' }]), ME, 'kg')
    expect(v.pending.map(p => p.id)).toEqual(['s4'])
    expect(v.unavailable).toEqual([])
  })
})

describe('orphanPointers: a share gone from the lists leaves the schedule', () => {
  const S = {
    week: { 1: ['r1', 'shared:s1'], 3: ['shared:gone'], 5: 'shared:s3' },
    dayPlan: { '2026-11-10': 'shared:gone2', '2026-11-11': 'shared:s4', '2026-11-12': 'SHARED:gone' },
  }
  it('names only pointers whose share is no longer listed at all', () => {
    const incoming = [{ id: 's1', state: 'accepted' }, { id: 's3', state: 'accepted', unavailable: 'custom-exercise' }, { id: 's4', state: 'pending' }]
    expect(orphanPointers(S, incoming).sort()).toEqual(['shared:gone', 'shared:gone2'])
  })
  it('names every pointer when nothing is shared with you any more', () => {
    expect(orphanPointers(S, []).sort()).toEqual(['shared:gone', 'shared:gone2', 'shared:s1', 'shared:s3', 'shared:s4'])
  })
})

describe('sharedNames', () => {
  it('keeps the last name of a share that now comes without one, and forgets the shares that went', () => {
    const prev = { s1: 'Leg Day', s9: 'Old' }
    const incoming = [{ id: 's1', state: 'accepted', unavailable: 'custom-exercise' }, { id: 's2', state: 'pending', preview: { name: 'Mobility', exercises: 3 } }]
    expect(sharedNames(incoming, prev)).toEqual({ s1: 'Leg Day', s2: 'Mobility' })
  })
})
