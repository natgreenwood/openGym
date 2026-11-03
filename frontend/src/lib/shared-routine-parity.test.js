/* The server's list of what leaves a sharer's routine (api/shared-routine.js, routine sharing),
 * pinned against what the plan export keeps (cleanEx and buildPlanBundle in ./plan-share.js).
 *
 * The API image cannot import the frontend, so the list is a hand copy (docs/ARCHITECTURE.md,
 * "Code that exists twice on purpose"). It is an allowlist on the server: a field cleanEx learns
 * to keep and the list does not is silently withheld from every recipient. So the field names
 * are compared both ways, from cleanEx's own source, and a rich slot is run through both.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPlanBundle } from './plan-share.js'
import { ROUTINE_FIELDS, SLOT_FIELDS, SLOT_WITHHELD, sharedRoutine } from '../../../api/shared-routine.js'

// Every key cleanEx can write: the ones it starts the object with and every `o.<key> =` after.
function cleanExKeys() {
  const src = readFileSync(new URL('./plan-share.js', import.meta.url), 'utf8')
  const start = src.indexOf('function cleanEx(e) {')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  const init = /const o = \{([^}]*)\}/.exec(body)[1].split(',').map(p => p.split(':')[0].trim()).filter(Boolean)
  const set = [...body.matchAll(/\bo\.(\w+)\s*=/g)].map(m => m[1])
  return new Set([...init, ...set])
}

describe('shared routine fields: api/shared-routine.js against the plan export', () => {
  it('the slot list is exactly what cleanEx keeps, less the fields withheld on purpose', () => {
    const kept = cleanExKeys()
    expect(kept.size).toBeGreaterThan(20)   // the parse found cleanEx
    expect([...SLOT_FIELDS, ...SLOT_WITHHELD].sort()).toEqual([...kept].sort())
    expect(SLOT_FIELDS.filter(k => SLOT_WITHHELD.includes(k))).toEqual([])
  })

  it('the routine list is what buildPlanBundle keeps on a routine, `ex` aside', () => {
    const r = { id: 'r1', name: 'Push', emoji: 'dumbbell', prog: { kind: 'linear' }, excludeFromProgression: true, ex: [], notes: 'x', _ts: 1 }
    const [exported] = buildPlanBundle({ unit: 'kg', routines: [r], customEx: [], week: {} }).routines
    expect(Object.keys(exported).filter(k => k !== 'ex').sort()).toEqual([...ROUTINE_FIELDS].sort())
  })

  it('a slot the export keeps arrives with the same fields on the server side', () => {
    const slot = {
      id: '0001', sets: 3, reps: 8, weight: 60, prog: { kind: 'double' }, inc: 2.5, repsMin: 6, repsMax: 10,
      restSec: 120, warmupRestSec: 60, note: 'Pause', warmupSets: 2, sg: 'a', sgName: 'Pair', sgRest: 90,
      _ts: 5, _f: { weight: 5 }, photo: 'f00d'
    }
    const [exported] = buildPlanBundle({ unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [slot] }], customEx: [], week: {} }).routines
    const projected = sharedRoutine({ id: 'r1', name: 'Push', ex: [slot] })
    expect(Object.keys(projected.ex[0]).sort()).toEqual(Object.keys(exported.ex[0]).sort())
  })
})
