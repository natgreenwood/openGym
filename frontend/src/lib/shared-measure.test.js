/* The size cap on a shared routine is one measure on both sides (NATG-670 AC1): the server judges
 * with api/shared-routine.js, the routine page with api/shared-measure.js, the same code the
 * server re-exports. What could still split them is how bytes are counted, so the count is held
 * here against Node's own (Buffer.byteLength, what the server used before) and a browser's (Blob)
 * on a routine full of text that is not ASCII, at the cap and one byte past it. */
import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import { sharedBytes, sharedOverCap, sharedRoutine, MAX_SHARED_BYTES } from '../../../api/shared-measure.js'
import * as server from '../../../api/shared-routine.js'

const json = r => JSON.stringify(sharedRoutine(r))
// A routine whose projection is exactly `bytes` long: notes in three scripts and an emoji, padded
// to the byte with ASCII in the last note. A lone surrogate is in there too: both sides count it
// as U+FFFD, three bytes.
function sized(bytes) {
  const note = 'Pausé ✓ 日本語のメモ 💪 \uD800 '
  const r = {
    id: 'r1', name: 'Pousée 🏋️', emoji: '💪',
    ex: Array.from({ length: 900 }, (_, i) => ({ id: String(i).padStart(4, '0'), sets: 3, reps: 10, note }))
  }
  while (Buffer.byteLength(json(r)) > bytes) r.ex.pop()
  r.ex.at(-1).note += 'a'.repeat(bytes - Buffer.byteLength(json(r)))
  return r
}

describe('shared routine size: the app and the server count the same bytes', () => {
  it.each([
    [MAX_SHARED_BYTES, false],
    [MAX_SHARED_BYTES + 1, true]
  ])('at %i bytes, over the cap: %s', (bytes, over) => {
    const r = sized(bytes)
    expect(Buffer.byteLength(json(r))).toBe(bytes)
    expect(new Blob([json(r)]).size).toBe(bytes)
    expect(sharedBytes(r)).toBe(bytes)
    expect(server.sharedBytes(r)).toBe(bytes)
    expect(sharedOverCap(r)).toBe(over)
    expect(server.sharedOverCap(r)).toBe(over)
  })
})
