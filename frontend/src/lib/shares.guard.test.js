// NATG-486, sharer side. With the share lists kept on this device, the custom-exercise guard
// always has something to go by: the list, kept or fresh, or else it holds a custom exercise back
// from every routine (the gap NATG-485 left). And a replace of your document (a backup restore, a
// reset) ends the shares of every routine it drops, for good (NATG-487), so the confirm says so.
import { describe, expect, it } from 'vitest'
import { shareGuard, guardHolds, sharesLostBy, sharesLostLine } from './shares.js'

describe('the sharer’s custom-exercise guard with a kept list (NATG-485 gap)', () => {
  const mine = { outgoing: [{ id: 'a', routineId: 'r1', to: { id: 'u2', name: 'Jo' } }] }
  it('goes by the list it has, fresh or kept', () => {
    const g = shareGuard(true, mine)
    expect(g.state).toBe('known')
    expect(guardHolds(g, 'r1')).toBe(true)
    expect(guardHolds(g, 'r2')).toBe(false)
  })
  it('holds a custom exercise back from every routine while there is no list, loading or failed', () => {
    expect(guardHolds(shareGuard(true, null, false), 'r2')).toBe(true)
    const failed = shareGuard(true, null, true)
    expect(failed.state).toBe('failed')
    expect(guardHolds(failed, 'r2')).toBe(true)
  })
  it('holds nothing back while sharing is unavailable', () => {
    expect(guardHolds(shareGuard(false, null, true), 'r1')).toBe(false)
  })
})

describe('sharesLostBy: what a backup restore or a reset ends for good (NATG-487)', () => {
  const outgoing = [{ id: 'a', routineId: 'r1' }, { id: 'b', routineId: 'r1' }, { id: 'c', routineId: 'r2' }]
  it('counts the shares of every routine the new document drops', () => {
    expect(sharesLostBy(outgoing, [{ id: 'r1' }])).toBe(1)
    expect(sharesLostBy(outgoing, [])).toBe(3)
    expect(sharesLostBy(outgoing, [{ id: 'r1' }, { id: 'r2' }])).toBe(0)
    expect(sharesLostBy(null, [])).toBe(0)
  })
})

describe('sharesLostLine', () => {
  it('says nothing when no share ends, and counts the people when some do', () => {
    expect(sharesLostLine(0)).toBe('')
    expect(sharesLostLine(1)).toBe('It also stops sharing with 1 person for good: sharing again later sends a new invite.')
    expect(sharesLostLine(3)).toBe('It also stops sharing with 3 people for good: sharing again later sends a new invite.')
  })
})
