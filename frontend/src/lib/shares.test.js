import { describe, expect, it } from 'vitest'
import { sharingAvailable, sharesOf, customExercisesIn, sharedWith, shareCounts, initials, filterPeople, shareError } from './shares.js'

// The one gate behind every share action (NATG-485 AC2). Three ways sharing is unavailable, and
// each must read as "no" from the same check: the admin option off, nobody signed in, local mode.
describe('sharingAvailable', () => {
  const user = { id: 'u1', name: 'Sam' }
  it('is on only with the server flag and a signed-in user', () => {
    expect(sharingAvailable({ shares: true }, user)).toBe(true)
  })
  it('is off while the admin option is off: the server sends no `shares` key', () => {
    expect(sharingAvailable({ media: {} }, user)).toBe(false)
    expect(sharingAvailable({ shares: false }, user)).toBe(false)
  })
  it('is off when signed out, which is also local mode on a phone (no user, no server)', () => {
    expect(sharingAvailable({ shares: true }, null)).toBe(false)
    expect(sharingAvailable(null, null)).toBe(false)
  })
  it('is off before the config has loaded, and in the demo', () => {
    expect(sharingAvailable(null, user)).toBe(false)
    expect(sharingAvailable({ shares: true }, user, { demo: true })).toBe(false)
  })
  it('takes only a real true, not something truthy', () => {
    expect(sharingAvailable({ shares: 'yes' }, user)).toBe(false)
  })
})

describe('customExercisesIn', () => {
  const S = { customEx: [{ id: 'c1', n: 'Cable Y-raise' }, { id: 'c2', n: 'Landmine Press' }] }
  it('finds the custom exercises the way the server does, by the profile’s own customEx ids', () => {
    const r = { ex: [{ id: 'bench' }, { id: 'c2' }, { id: 'c1' }, { id: 'c2' }] }
    expect(customExercisesIn(r, S).map(c => c.n)).toEqual(['Landmine Press', 'Cable Y-raise'])
  })
  it('finds none in a routine of library exercises, or with nothing to read', () => {
    expect(customExercisesIn({ ex: [{ id: 'bench' }] }, S)).toEqual([])
    expect(customExercisesIn(null, S)).toEqual([])
    expect(customExercisesIn({ ex: [{ id: 'c1' }] }, {})).toEqual([])
  })
})

describe('sharesOf', () => {
  it('hands back the lists only to the profile they were loaded for', () => {
    const shares = { uid: 'u1', outgoing: [] }
    expect(sharesOf(shares, { id: 'u1' })).toBe(shares)
    expect(sharesOf(shares, { id: 'u2' })).toBe(null)
    expect(sharesOf(shares, null)).toBe(null)
    expect(sharesOf(null, { id: 'u1' })).toBe(null)
  })
})

describe('sharedWith', () => {
  const outgoing = [
    { id: 'b', to: { id: 'u3', name: 'Tom Becker' }, routineId: 'r1' },
    { id: 'a', to: { id: 'u2', name: 'Alex Morgan' }, routineId: 'r1' },
    { id: 'c', to: { id: 'u4', name: 'Jo Patel' }, routineId: 'r2' }
  ]
  it('lists the people one routine is shared with, by name', () => {
    expect(sharedWith(outgoing, 'r1').map(o => o.to.name)).toEqual(['Alex Morgan', 'Tom Becker'])
  })
  it('is empty for a routine shared with nobody, or before the list has loaded', () => {
    expect(sharedWith(outgoing, 'r9')).toEqual([])
    expect(sharedWith(null, 'r1')).toEqual([])
  })
  it('counts shares per routine for the routines list', () => {
    expect(shareCounts(outgoing)).toEqual({ r1: 2, r2: 1 })
    expect(shareCounts(undefined)).toEqual({})
  })
})

describe('initials', () => {
  it('takes the first letters of the first two words', () => {
    expect(initials('Alex Morgan')).toBe('AM')
    expect(initials('uma ito kato')).toBe('UI')
    expect(initials('Priya')).toBe('P')
  })
  it('never renders an empty avatar', () => {
    expect(initials('   ')).toBe('?')
    expect(initials(null)).toBe('?')
  })
})

describe('filterPeople', () => {
  const users = [{ id: '1', name: 'Zoë Adams' }, { id: '2', name: 'Sam Keller' }]
  it('matches anywhere in the name, ignoring case and accents', () => {
    expect(filterPeople(users, 'zoe').map(u => u.id)).toEqual(['1'])
    expect(filterPeople(users, 'KELL').map(u => u.id)).toEqual(['2'])
  })
  it('gives everyone back for an empty search, and nobody for no match', () => {
    expect(filterPeople(users, '  ')).toHaveLength(2)
    expect(filterPeople(users, 'zed')).toEqual([])
  })
})

describe('shareError', () => {
  const err = (status, code) => Object.assign(new Error('x'), { status, data: code ? { code } : {} })
  it('names the routine in the title and says nobody got it on a network failure', () => {
    const m = shareError(new TypeError('Failed to fetch'), 'Push Day')
    expect(m.title).toBe('Couldn’t share Push Day')
    expect(m.message).toMatch(/connection/)
    expect(m.message).toMatch(/Nobody got it/)
  })
  // NATG-484's note: declined and removed shares hold their slot until the sharer unshares, and
  // the sharer cannot see which those are, so the message has to send them to the list.
  it('points the sharer to the shared-with list when the cap is reached', () => {
    const m = shareError(err(409, 'share-limit'), 'Push Day')
    expect(m.message).toMatch(/sharing limit/)
    expect(m.message).toMatch(/“Shared with” list/)
    expect(m.message).toMatch(/unshare/)
    expect(m.refresh).toBeFalsy()
  })
  it('refreshes the people list when someone picked has gone', () => {
    expect(shareError(err(404, 'user-missing'), 'Push Day').refresh).toBe(true)
  })
  it('has its own words for the other codes the route answers', () => {
    expect(shareError(err(400, 'custom-exercise'), 'R').message).toMatch(/custom exercise/)
    expect(shareError(err(404, 'routine-missing'), 'R').message).toMatch(/sync/)
    expect(shareError(err(403, 'sharing-off'), 'R').message).toMatch(/isn’t switched on/)
    expect(shareError(err(429), 'R').message).toMatch(/last hour/)
    expect(shareError(err(503), 'R').message).toMatch(/server couldn’t save/)
  })
})
