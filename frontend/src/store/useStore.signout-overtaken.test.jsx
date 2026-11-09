// @vitest-environment happy-dom

/* NATG-581. A sign-out another tab overtook (it signed a different account in while this one
   waited) comes back { cancelled: true }, and Settings says so in a toast. Handing this tab over
   to the new account closes every sheet and the toast (useUI's account-change subscriber). The
   store hands over before it returns, so that has happened by the time the toast shows, and this
   tab's storage event for the new owner, still queued, finds nothing left to hand over. With the
   real useUI: the toast is still there afterwards, and the sheet open during the sign-out closed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ api: null }))
vi.mock('../lib/api.js', () => ({ api: (...a) => h.api(...a), setRemoteAuth: () => {} }))

let useStore, useUI
beforeEach(async () => {
  localStorage.clear()
  localStorage.setItem('gym_owner', 'x1')
  localStorage.setItem('gym_owner_name', 'Xavi')
  vi.resetModules()
  ;({ useStore } = await import('./useStore.js'))
  ;({ useUI } = await import('./useUI.js'))
  useStore.setState({ user: { id: 'x1', name: 'Xavi' }, ready: true })
})
afterEach(() => {
  useStore.setState({ user: null, ready: false })
  useUI.setState({ sheets: [], toastMsg: '', toastAction: null })
  localStorage.clear()
})

describe('the toast for a sign-out another tab overtook', () => {
  it('is still showing after this tab has handed over to the new account', async () => {
    const logouts = []
    let release, asked
    const answered = new Promise(r => { release = r })
    const arrived = new Promise(r => { asked = r })
    h.api = async (path, opts = {}) => {
      const method = opts.method || 'GET'
      if (method === 'POST' && path.startsWith('/api/logout')) { logouts.push(path); return { ok: true } }
      if (method === 'GET' && path === '/api/data') { asked(); await answered; return { state: null, rev: 0 } }
      throw new Error('unexpected ' + method + ' ' + path)
    }
    const pull = useStore.getState().pullState()
    await arrived
    const leaving = useStore.getState().signOut()   // waits for the pull
    useUI.getState().openSheet(() => null, { kind: 'center', locked: true })   // "Not everything is on your server yet"

    // Another tab signs in as Yan: the name goes first, then the owner. This tab's storage event
    // for it has not run yet.
    localStorage.setItem('gym_owner_name', 'Yan')
    localStorage.setItem('gym_owner', 'y1')
    expect(useStore.getState().user?.id).toBe('x1')

    release()
    await pull
    const r = await leaving
    expect(r).toEqual({ cancelled: true })
    expect(logouts).toEqual([])
    expect(useStore.getState().user).toBeNull()   // handed over before it returned
    expect(useUI.getState().sheets).toEqual([])   // the sheet closed with it

    const msg = 'You weren’t signed out. This browser is now signed in as Yan.'
    useUI.getState().toast(msg, { ms: 5000 })   // what Settings shows for it
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: 'x1', newValue: 'y1' }))
    expect(useUI.getState().toastMsg).toBe(msg)
    expect(localStorage.getItem('gym_owner')).toBe('y1')
  })
})
