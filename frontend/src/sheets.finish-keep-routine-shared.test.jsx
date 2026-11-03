// @vitest-environment happy-dom
// NATG-485 (Architect's review, point 1): the finish summary's "Add it to …" must not put a custom
// exercise into a routine that is shared. The library exercises still go in; the custom ones stay
// out, with a line that says why.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'

vi.mock('./lib/api.js', async orig => ({ ...(await orig()), api: vi.fn(() => Promise.resolve({ incoming: [], outgoing: [] })) }))

import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { finishWorkoutNow } from './sheets.jsx'
import { registerCustom } from './lib/exercises.js'

const clone = v => JSON.parse(JSON.stringify(v))
const S = () => useStore.getState().S
const CUSTOM = { id: 'cx1', n: 'Cable Y-raise', custom: true, bp: 'shoulders', tg: 'delts', eq: 'cable', sm: [], st: [] }
const ME = { id: 'u1', name: 'Sam' }
const mounted = []
let host

function renderTopSheet() {
  const sheet = useUI.getState().sheets.at(-1)
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
}
const settle = () => act(async () => {})
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)

const bench = { id: '0025', rid: 'r1', target: { sets: 1, reps: 5, weight: 60 }, sets: [{ w: 60, r: 5, done: true }] }
const raise = { id: '0334', rid: 'r1', addedInSession: true, target: { sets: 2, reps: 12, weight: 8 }, sets: [{ w: 8, r: 12, done: true }] }
const yraise = { id: 'cx1', rid: 'r1', addedInSession: true, target: { sets: 3, reps: 15, weight: 5 }, sets: [{ w: 5, r: 15, done: true }] }

function install(entries, { shared = true } = {}) {
  const st = clone(DEF)
  st.routines = [{ id: 'r1', name: 'Push A', ex: [{ id: '0025', sets: 1, reps: 5, weight: 60 }] }]
  st.customEx = [CUSTOM]
  registerCustom(st.customEx)
  st.active = {
    id: 'fin', d: '2026-09-28', start: Date.now() - 20 * 60000, routineIds: ['r1'], routineId: 'r1', name: 'Push A', bw: null, cur: 0,
    entries,
  }
  const outgoing = shared ? [{ id: 's1', to: { id: 'u2', name: 'Jo' }, routineId: 'r1' }] : []
  useStore.setState({ S: st, user: ME, config: { shares: true }, shares: { uid: 'u1', incoming: [], outgoing, etag: 'e' } })
}
async function finish(entries, opts) {
  install(entries, opts)
  act(() => finishWorkoutNow())
  renderTopSheet()
  await settle()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  useUI.setState({ sheets: [], timer: null, work: null })
})
afterEach(() => {
  mounted.splice(0).forEach(r => act(() => r.unmount()))
  document.body.innerHTML = ''
})

describe('finish summary: keep an added exercise in a shared routine', () => {
  it('adds only the library exercises, and says the custom one stayed out', async () => {
    await finish([clone(bench), clone(raise), clone(yraise)])
    const line = host.querySelector('[data-keep-in-routine]').textContent
    expect(line).toContain('Custom exercises can’t go in “Push A” while it’s shared: Cable Y-Raise. Unshare it first to add them.')
    // The button counts what it will add: one, not two.
    act(() => button('Add it to “Push A”').click())
    expect(S().routines[0].ex.map(x => x.id)).toEqual(['0025', '0334'])
    expect(host.textContent).toContain('Added to “Push A”')
  })

  it('offers no button when every addition is custom', async () => {
    await finish([clone(bench), clone(yraise)])
    expect(host.querySelector('[data-keep-in-routine] button')).toBeNull()
    expect(host.textContent).toContain('Unshare it first to add them.')
    expect(S().routines[0].ex.map(x => x.id)).toEqual(['0025'])
  })

  it('keeps a custom exercise in a routine that is not shared, as before', async () => {
    await finish([clone(bench), clone(raise), clone(yraise)], { shared: false })
    expect(host.textContent).not.toContain('Unshare it first')
    act(() => button('Add them to “Push A”').click())
    expect(S().routines[0].ex.map(x => x.id)).toEqual(['0025', '0334', 'cx1'])
  })
})
