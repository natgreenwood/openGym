// A row in a grouped card (.sect-b, a grouped menu) sits flush with a parent that has overflow:hidden,
// so the global ring, drawn 2px outside, lost its top and sides and read as a separator under the row
// (NATG-652). Those rows draw it inside their own edge, the way .share-person already did.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rule = sel => css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}'))?.[1]

describe('focus ring on rows in clipped groups', () => {
  it.each(['.sect-b .lrow:focus-visible', '.menu-group.grouped .menu-item:focus-visible'])('%s draws the ring inside the row', sel => {
    const decls = rule(sel)
    expect(decls).toBeDefined()
    expect(decls).toMatch(/outline-offset:-2\.5px/)
    expect(decls).toMatch(/border-radius:var\(--r-card\)/)
    // colour and width come from the global ring, so a theme or accent change reaches these rows too
    expect(decls).not.toMatch(/outline:|outline-color/)
  })
  it('keeps the clipping that rounds the cards', () => {
    expect(rule('.sect-b')).toMatch(/overflow:hidden/)
    expect(rule('.menu-group.grouped .menu-list')).toMatch(/overflow:hidden/)
  })
  it('leaves the global ring outside the element', () => {
    expect(rule(':focus-visible')).toMatch(/outline-offset:2px/)
  })
})
