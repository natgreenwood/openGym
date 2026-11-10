// @vitest-environment happy-dom
// NATG-670: `sync.unsettled` on a store that starts from what an earlier session saved. A copy
// that starts owed (a push that failed), or with an edit saved but never pushed (its `_ts` past
// the revision it descends from, no gym_dirty), carries edits the share lists kept here never
// judged: it starts on, and goes off once the first push lands and the lists are heard from after
// it. A copy in step with the server starts off.
import { beforeEach, expect, it, vi } from 'vitest'
import { freshStore } from '../test-utils/fresh-store.js'

const h = vi.hoisted(() => ({ api: null }))
vi.mock('../lib/api.js', () => ({ api: (...a) => h.api(...a), setRemoteAuth: () => {} }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: () => {}, stopRest: () => {}, abandonWork: () => {}, closeAll: () => {}, dismissToast: () => {} }) } }))

const USER = { id: 'u1', name: 'Sam' }
const T = Date.UTC(2026, 10, 9, 8)
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
let net
beforeEach(() => {
  localStorage.clear()
  net = { rev: 3, etag: 'e1', puts: 0 }
  h.api = async (path, o = {}) => {
    const method = o.method || 'GET'
    if (path === '/api/shares') return { incoming: [], outgoing: [], etag: net.etag }
    if (path === '/api/data/rev') return { rev: net.rev, shares: net.etag }
    if (path === '/api/data' && method === 'PUT') { net.puts++; return { ok: true, rev: ++net.rev } }
    if (path === '/api/data') return { state: {}, rev: net.rev }
    return {}
  }
})

// What the earlier session left: its copy at `ts`, the revision it descends from (stamped T), and
// whether it was marked owed. The store fills in every default a saved copy leaves out.
async function startWith({ ts, owed }) {
  localStorage.setItem('gym_owner', USER.id)
  localStorage.setItem('gym_user', JSON.stringify(USER))
  localStorage.setItem('gym_state_v1', JSON.stringify({ _ts: ts }))
  localStorage.setItem('gym_sync', JSON.stringify({ rev: net.rev, ts: T, uid: USER.id }))
  if (owed) localStorage.setItem('gym_dirty', '1')
  const { useStore: started } = await freshStore()
  started.setState({ user: USER, ready: true, config: { shares: true } })
  return started
}
const unsettled = s => s.getState().sync.unsettled

it.each([
  ['owed at start (a push that failed)', { ts: T + 1000, owed: true }],
  ['an edit saved but never pushed', { ts: T + 1000, owed: false }],
])('%s: starts on, and goes off after the first push lands and a later list arrives', async (_, at) => {
  const s = await startWith(at)
  expect(unsettled(s)).toBe(true)
  await s.getState().loadShares()   // lists heard from, but no push has landed
  expect(unsettled(s)).toBe(true)
  await s.getState().pushState()
  expect(net.puts).toBe(1)
  expect(unsettled(s)).toBe(true)
  await s.getState().loadShares()
  expect(unsettled(s)).toBe(false)
})

it('an edit saved but never pushed: a poll after the push lands, with the etag unchanged, settles it too', async () => {
  const s = await startWith({ ts: T + 1000, owed: false })
  await s.getState().loadShares()
  await s.getState().pushState()
  expect(unsettled(s)).toBe(true)
  window.dispatchEvent(new Event('online'))
  await tick()
  expect(unsettled(s)).toBe(false)
})

it('a copy in step with the server starts off', async () => {
  const s = await startWith({ ts: T, owed: false })
  expect(unsettled(s)).toBe(false)
})
