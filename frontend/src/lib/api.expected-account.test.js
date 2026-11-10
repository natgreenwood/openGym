// @vitest-environment happy-dom

/* X-Expected-Account (NATG-558): a sync request names the account it is for, and the server refuses
   a session that is another account's with a 412. Only over the same-origin cookie, which another
   tab can switch; a paired phone's bearer fixes its own account and sends no such header. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const headersOf = init => new Headers(init.headers)

let api, setRemoteAuth, fetchMock
beforeEach(async () => {
  vi.resetModules()
  ;({ api, setRemoteAuth } = await import('./api.js'))
  fetchMock = vi.fn(async () => json({ state: null, rev: 0 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { setRemoteAuth('', null); vi.unstubAllGlobals() })

describe('the expected account on the cookie transport', () => {
  it('names the account in the header, and the option itself never reaches fetch', async () => {
    await api('/api/data', { method: 'PUT', body: '{}', expect: 'u1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/data')
    expect(headersOf(init).get('X-Expected-Account')).toBe('u1')
    expect(init).not.toHaveProperty('expect')
    expect(init).toMatchObject({ method: 'PUT', body: '{}' })
  })

  it('a GET carries it too', async () => {
    await api('/api/data/rev', { expect: 'u1' })
    expect(headersOf(fetchMock.mock.calls[0][1]).get('X-Expected-Account')).toBe('u1')
  })

  it('without the option no header goes', async () => {
    await api('/api/data')
    await api('/api/data', { method: 'PUT', body: '{}' })
    for (const [, init] of fetchMock.mock.calls) expect(headersOf(init).has('X-Expected-Account')).toBe(false)
  })
})

describe('a paired phone (bearer transport)', () => {
  it('sends no expected account, whatever the call site passes', async () => {
    setRemoteAuth('https://gym.test', 'tok')
    await api('/api/data', { expect: 'u1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gym.test/api/data')
    const headers = headersOf(init)
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.has('X-Expected-Account')).toBe(false)
    expect(init).not.toHaveProperty('expect')
  })
})

describe('the server\'s refusal', () => {
  it('a 412 rejects with its status and the server\'s code', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'session is for another account', code: 'account-mismatch' }, 412))
    await expect(api('/api/data', { expect: 'u1' })).rejects.toMatchObject({
      status: 412, code: 'account-mismatch', data: { code: 'account-mismatch' },
    })
  })

  // Only a 412 carries its code: the store files every other refusal under 'http' (failed), and the
  // screens say "Server error (HTTP n)" for those as before.
  it('another status keeps no code, even with one in its body', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'busy', code: 'busy' }, 503))
    const e = await api('/api/data', { expect: 'u1' }).catch(e => e)
    expect(e).toMatchObject({ status: 503, data: { code: 'busy' } })
    expect(e.code).toBeUndefined()
  })
})
