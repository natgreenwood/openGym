// @vitest-environment happy-dom
// NATG-485 AC3: the share sheet. A searchable list of the people on this server, several picked at
// once, the selection kept while searching, and someone who already has the routine marked
// "Already shared" without saying what they did with it. Every state the design draws: loading,
// nobody else on the server, no match, and a failed share that keeps the selection.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ recipients: null, create: null }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn((path, opts) => {
    if (path === '/api/shares/recipients') return net.recipients()
    if (path === '/api/shares' && opts?.method === 'POST') return net.create(JSON.parse(opts.body))
    return Promise.reject(new Error('unexpected ' + path))
  })
}))

import ShareRoutineSheet from './ShareRoutineSheet.jsx'
import { api } from '../lib/api.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host

const PEOPLE = [{ id: 'u2', name: 'Alex Morgan' }, { id: 'u3', name: 'Jo Patel' }, { id: 'u4', name: 'Priya Shah' }, { id: 'u5', name: 'Sam Keller' }]
const ROUTINE = { id: 'r1', name: 'Push Day' }
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const fail = (status, code) => Promise.reject(Object.assign(new Error('x'), { status, data: { code } }))

async function mount(props = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const close = vi.fn(), onShared = vi.fn()
  act(() => root.render(<ShareRoutineSheet routine={ROUTINE} already={[]} close={close} onShared={onShared} {...props} />))
  await settle()
  return { close, onShared }
}
const row = name => [...host.querySelectorAll('[role="checkbox"]')].find(b => b.textContent.includes(name))
const shareBtn = () => host.querySelector('.btn.primary')
const type = value => {
  const input = host.querySelector('input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(() => {
  vi.clearAllMocks()
  net.recipients = () => Promise.resolve({ users: PEOPLE })
  net.create = () => Promise.resolve({ shares: [], etag: 'e' })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('ShareRoutineSheet', () => {
  it('shows a busy skeleton while the people load, with the search already focused', async () => {
    net.recipients = () => new Promise(() => {})
    await mount()
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(host.textContent).toContain('Loading people')
    expect(document.activeElement).toBe(host.querySelector('input'))
    expect(shareBtn().disabled).toBe(true)
    expect(shareBtn().textContent).toBe('Share')
  })

  it('picks several people, keeps them through a search, and shares with all of them at once', async () => {
    const { close, onShared } = await mount()
    expect(host.querySelector('h3').textContent).toBe('Share Push Day')
    act(() => row('Alex').click())
    act(() => row('Jo Patel').click())
    expect(row('Alex').getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('2 selected')
    expect(shareBtn().textContent).toBe('Share with 2 people')
    type('pri')
    expect([...host.querySelectorAll('[role="checkbox"]')].map(b => b.textContent)).toEqual(['PSPriya Shah'])
    act(() => row('Priya').click())
    type('')
    expect(host.textContent).toContain('3 selected')
    await act(async () => { shareBtn().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(api).toHaveBeenCalledWith('/api/shares', { method: 'POST', body: JSON.stringify({ routineId: 'r1', to: ['u2', 'u3', 'u4'] }) })
    expect(close).toHaveBeenCalledOnce()
    expect(onShared).toHaveBeenCalledWith(3)
  })

  it('marks someone who already has it as "Already shared", and they cannot be picked again', async () => {
    await mount({ already: ['u5'] })
    const sam = row('Sam Keller')
    expect(sam.getAttribute('aria-disabled')).toBe('true')
    expect(sam.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('#' + CSS.escape(sam.getAttribute('aria-describedby'))).textContent).toBe('Already shared')
    act(() => sam.click())
    expect(host.textContent).not.toContain('selected')
    expect(shareBtn().disabled).toBe(true)
  })

  it('says no one matches, and keeps what was picked', async () => {
    await mount()
    act(() => row('Alex').click())
    type('zed')
    expect(host.textContent).toContain('No one called “zed” on this server.')
    expect(shareBtn().textContent).toBe('Share with 1 person')
  })

  it('says when nobody else has a profile here, with only OK to tap', async () => {
    net.recipients = () => Promise.resolve({ users: [] })
    const { close } = await mount()
    expect(host.textContent).toContain('No one else has a profile on this server yet.')
    expect(host.textContent).toContain('When someone joins, you can share with them here.')
    act(() => shareBtn().click())
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the selection after a failed share, says nobody got it, and moves focus to Try again', async () => {
    net.create = () => Promise.reject(new TypeError('Failed to fetch'))
    const { close } = await mount()
    act(() => row('Alex').click())
    await act(async () => { shareBtn().click(); await new Promise(r => setTimeout(r, 0)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert.textContent).toContain('Couldn’t share Push Day')
    expect(alert.textContent).toContain('Check your connection and try again. Nobody got it yet.')
    expect(row('Alex').getAttribute('aria-checked')).toBe('true')
    expect(shareBtn().textContent).toBe('Try again')
    expect(document.activeElement).toBe(shareBtn())
    expect(close).not.toHaveBeenCalled()
  })

  // NATG-484: a declined share holds its place under the cap until the sharer unshares it.
  it('sends the sharer to the shared-with list when the sharing limit is reached', async () => {
    net.create = () => fail(409, 'share-limit')
    await mount()
    act(() => row('Alex').click())
    await act(async () => { shareBtn().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(host.querySelector('[role="alert"]').textContent).toMatch(/unshare anyone you no longer share with in the “Shared with” list/)
  })

  it('loads the people again when someone picked has left, and drops them from the selection', async () => {
    net.create = () => fail(404, 'user-missing')
    await mount()
    act(() => row('Alex').click())
    act(() => row('Jo Patel').click())
    net.recipients = () => Promise.resolve({ users: PEOPLE.filter(p => p.id !== 'u3') })
    await act(async () => { shareBtn().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(host.querySelector('[role="alert"]').textContent).toContain('Someone you picked is no longer on this server.')
    expect(row('Jo Patel')).toBeUndefined()
    expect(host.textContent).toContain('1 selected')
  })

  it('says the people could not be loaded, and tries again', async () => {
    net.recipients = () => Promise.reject(new TypeError('Failed to fetch'))
    await mount()
    expect(host.querySelector('[role="alert"]').textContent).toContain('Couldn’t load the people on this server')
    net.recipients = () => Promise.resolve({ users: PEOPLE })
    await act(async () => { shareBtn().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(row('Alex Morgan')).toBeTruthy()
  })

  // SEC-01: a sheet closed under it (the account changed) ignores what answers afterwards.
  it('does nothing with a share answer that lands after it has gone', async () => {
    let answer
    net.create = () => new Promise(resolve => { answer = resolve })
    const { close, onShared } = await mount()
    act(() => row('Alex').click())
    act(() => shareBtn().click())
    act(() => root.unmount())
    await act(async () => { answer({ shares: [], etag: 'e' }); await new Promise(r => setTimeout(r, 0)) })
    expect(close).not.toHaveBeenCalled()
    expect(onShared).not.toHaveBeenCalled()
    root = createRoot(document.createElement('div'))
  })

  it('gives focus back to what opened it when it closes', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    await mount({ returnFocus: opener })
    act(() => root.unmount())
    expect(document.activeElement).toBe(opener)
    root = createRoot(document.createElement('div'))
    opener.remove()
  })
})
