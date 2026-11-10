// @vitest-environment happy-dom

/* A sign-out wipes the last snapshot sent to the watch (gym_watch_last_sent, lib/watch-sync.js): it
   holds the account's running workout, and a shared phone keeps nothing of the account that left.
   With no record, the next account's phone sends the watch nothing in its place. (NATG-613) */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn(), stopRest: vi.fn(), abandonWork: vi.fn(), closeAll: vi.fn(), dismissToast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { WATCH_LAST_SENT_KEY } from '../lib/watch-settings.js'
import { DEF, useStore } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const sent = JSON.stringify({ v: 1, active: { id: 'w-9', name: 'Push day', entries: [] } })

beforeEach(() => { localStorage.clear(); api.mockReset(); api.mockResolvedValue({ ok: true }) })
afterEach(() => { localStorage.clear(); useStore.setState({ S: clone(DEF), user: null, ready: false }) })

describe('signing out', () => {
  it('wipes what the watch was last sent', async () => {
    localStorage.setItem('gym_owner', 'u1')
    useStore.setState({ S: { ...clone(DEF), _ts: 1 }, user: { id: 'u1', name: 'Jo' }, ready: true })
    localStorage.setItem(WATCH_LAST_SENT_KEY, sent)
    await useStore.getState().signOut({ force: true })
    expect(useStore.getState().user).toBeNull()
    expect(localStorage.getItem(WATCH_LAST_SENT_KEY)).toBeNull()
  })
})
