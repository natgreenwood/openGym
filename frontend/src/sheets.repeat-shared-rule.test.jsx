// @vitest-environment happy-dom
// NATG-520: "Repeat today" on a workout from a routine shared with you keeps that routine's
// progression rule, the way a repeat of your own routine's workout does: on the repeat session
// you train (`target.prog`), and on a routine saved from the workout, from its repeat and from a
// repeat of that. A share that ends before the repeat leaves no rule to read, the same as a
// routine of your own that was deleted. The real store, session builders and sheets throughout.
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('./lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
import { api } from './lib/api.js'
let DEF, useStore, useUI, sheets, saveSessionAsRoutine, sharedViewOf
const clone = v => structuredClone(v)
const ME = { id: 'u2', name: 'Jo' }
const fresh = { offline: false, pending: false, auth: false, lastError: null, lastSynced: 0, server: null }
const BENCH = '0025', ROW = '0027'
const setup = { id: BENCH, sets: 3, reps: 12, repsMin: 8, weight: 60 }
const share = prog => ({ id: 's1', state: 'accepted', from: { id: 'u1', name: 'Sam' }, unit: 'kg', hash: 'h-' + prog, routine: { id: 'r9', name: 'Theirs', prog, ex: [{ ...setup }] } })
let net
beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  ;({ DEF, useStore } = await import('./store/useStore.js'))
  ;({ useUI } = await import('./store/useUI.js'))
  sheets = await import('./sheets.jsx')
  ;({ saveSessionAsRoutine } = await import('./lib/session-routines.js'))
  ;({ sharedViewOf } = await import('./lib/shared-routines.js'))
  const { setNav } = await import('./lib/nav.js')
  setNav(vi.fn())
  localStorage.setItem('gym_owner', ME.id)
  localStorage.setItem('gym_user', JSON.stringify(ME))
  const S = clone(DEF)
  S.routines = []
  S.weighIn = false
  net = { incoming: [], etag: 'e1', rev: 1 }
  useStore.setState({ S, user: ME, ready: true, config: { shares: true }, shares: null, sharesError: false, sync: { ...fresh } })
  useUI.setState({ sheets: [] })
  localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: S._ts || 0 }))
  api.mockReset()
  api.mockImplementation(async (path, o = {}) => {
    if (path === '/api/shares') return { incoming: clone(net.incoming), outgoing: [], etag: net.etag }
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path === '/api/data' && o.method === 'PUT') return { ok: true, rev: ++net.rev }
    if (path === '/api/data') return { state: clone(useStore.getState().S), rev: net.rev }
    return {}
  })
})
afterEach(() => { useStore.setState({ ready: false, user: null }); useUI.setState({ sheets: [] }) })

const own = (id, prog, ex = [{ ...setup }]) => useStore.getState().update(s => { s.routines.push({ id, name: 'Mine', prog, ex }) })
const shareWith = async prog => { net.incoming = prog ? [share(prog)] : []; net.etag = 'e-' + (prog || 'gone'); await useStore.getState().loadShares() }
const active = () => useStore.getState().S.active
// Every set done, then Finish: the saved workout is the newest one.
const trainAndFinish = () => {
  useStore.getState().update(s => { s.active.entries.forEach(e => e.sets.forEach(x => { x.done = true })) })
  sheets.finishWorkoutNow()
  useUI.setState({ sheets: [] })
  return useStore.getState().S.workouts.at(-1)
}
// Save as routine the way the detail sheet does it, on a copy of the state: the rule per exercise.
const savedRules = w => {
  const draft = clone(useStore.getState().S)
  const id = saveSessionAsRoutine(draft, w, w.name, sharedViewOf(useStore.getState()))
  return draft.routines.find(r => r.id === id).ex.map(cfg => cfg.prog)
}
// A workout from `ids`, its repeat and a repeat of that: the rules on each repeat session as it
// is trained, and on a routine saved from each of the three workouts.
const chain = ids => {
  sheets.beginWorkout(ids, null)
  const first = trainAndFinish()
  sheets.repeatWorkout(first)
  const trained = [active().entries.map(e => e.target.prog)]
  const second = trainAndFinish()
  sheets.repeatWorkout(second)
  trained.push(active().entries.map(e => e.target.prog))
  const third = trainAndFinish()
  return { trained, saved: [first, second, third].map(savedRules) }
}

it.each(['double', 'triple', 'linear', 'greyskull'])('%s: the workout, its repeat and a repeat of that keep the rule, from your routine and from a shared one', async prog => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  own('r-own', prog)
  await shareWith(prog)
  const mine = chain(['r-own'])
  const theirs = chain(['shared:s1'])
  expect(useStore.getState().S.workouts.at(-1).sharedOrigin).toBe(true)
  expect({ own: mine.saved, shared: theirs.saved }).toEqual({ own: [[prog], [prog], [prog]], shared: [[prog], [prog], [prog]] })
  expect({ own: mine.trained, shared: theirs.trained }).toEqual({ own: [[prog], [prog]], shared: [[prog], [prog]] })
})

it('a combined repeat keeps each routine’s own rule: yours linear, the shared one double', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  own('r-own', 'linear', [{ id: ROW, sets: 2, reps: 10, weight: 40 }])
  await shareWith('double')
  const both = chain(['r-own', 'shared:s1'])
  expect(both.trained).toEqual([['linear', 'double'], ['linear', 'double']])
  expect(both.saved).toEqual([['linear', 'double'], ['linear', 'double'], ['linear', 'double']])
})

it('a share that ends before the repeat leaves no rule, as a deleted routine of your own does', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  own('r-own', 'double')
  await shareWith('double')
  sheets.beginWorkout(['r-own'], null)
  const mine = trainAndFinish()
  sheets.beginWorkout(['shared:s1'], null)
  const theirs = trainAndFinish()
  // Repeated while the share lasts, the rule comes with it.
  sheets.repeatWorkout(theirs)
  expect(active().entries.map(e => e.target.prog)).toEqual(['double'])
  const live = trainAndFinish()

  // The share ends and your routine is deleted: neither has a rule left to read.
  await shareWith(null)
  useStore.getState().update(s => { s.routines = [] })
  sheets.repeatWorkout(mine)
  expect(active().entries.map(e => e.target.prog)).toEqual([undefined])
  const mineAgain = trainAndFinish()
  sheets.repeatWorkout(theirs)
  expect(active().entries.map(e => e.target.prog)).toEqual([undefined])
  const theirsAgain = trainAndFinish()
  expect(savedRules(mineAgain)).toEqual([undefined])
  expect(savedRules(theirsAgain)).toEqual([undefined])
  expect(theirsAgain.sharedOrigin).toBe(true)
  // A repeat made while the share lasted carries the rule it was trained under.
  expect(savedRules(live)).toEqual(['double'])
})
