import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { customAccentVars } from './lib/accent.js'

const read = (f) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

// The body of the first top-level block whose prelude matches `head`, braces counted.
function block(css, head) {
  const at = css.search(head)
  if (at < 0) return ''
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  return ''
}
const rule = (css, sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`))?.[1] || ''
}
const token = (decls, name) => decls.match(new RegExp(`${name}:\\s*([^;}]+)`))?.[1]?.trim()

const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) }
const rgba = (v) => { const m = v.match(/rgba\(([^)]+)\)/); const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p[3] } }
const lum = (rgb) => { const l = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] }
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const over = ({ rgb, a }, bg) => rgb.map((c, i) => c * a + bg[i] * (1 - a))

describe('Increase Contrast (#707)', () => {
  const css = read('index.css')
  const hc = block(css, /@media\s*\(prefers-contrast:\s*more\)/)
  const themes = [
    ['dark', rule(css, ':root'), rule(hc, ':root')],
    ['light', rule(css, ':root[data-theme="light"]'), rule(hc, ':root[data-theme="light"]')],
  ]

  it.each(themes)('%s: secondary text reads at 4.5:1 on a card, hairlines get firmer', (_t, base, more) => {
    expect(more).not.toBe('')
    const card = hex(token(base, '--surface'))
    expect(ratio(over(rgba(token(more, '--label-2')), card), card)).toBeGreaterThanOrEqual(4.5)
    // label-3 is the tertiary text (hints, units): at least the large-text bar.
    expect(ratio(over(rgba(token(more, '--label-3')), card), card)).toBeGreaterThanOrEqual(3)
    for (const k of ['--label-2', '--label-3', '--sep', '--sep-op']) {
      expect(rgba(token(more, k)).a, k).toBeGreaterThan(rgba(token(base, k)).a)
    }
  })

  it('every accent keeps a 4.5:1 label on its filled button in both themes', () => {
    const accents = [...css.matchAll(/:root\[data-accent="(\w+)"\]\s*\{\s*--acc:var\(--(\w+)\)[^}]*--on-acc:(#\w+)/g)]
    expect(accents.length).toBeGreaterThanOrEqual(8)
    const darkInk = token(rule(hc, ':root:not([data-theme="light"])'), '--on-acc')
    const lightInks = Object.fromEntries([...css.matchAll(/((?::root\[data-theme="light"\]\[data-accent="\w+"\],?\s*)+)\{\s*--on-acc:(#\w+)/g)]
      .flatMap((m) => [...m[1].matchAll(/data-accent="(\w+)"/g)].map((a) => [a[1], m[2]])))
    for (const [, name, colour, ink] of accents) {
      const dark = hex(token(rule(hc, ':root'), `--${colour}`))
      const light = hex(token(rule(hc, ':root[data-theme="light"]'), `--${colour}`))
      expect(ratio(hex(darkInk || ink), dark), `${name} dark`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(hex(lightInks[name] || ink), light), `${name} light`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// NATG-592: the import sheets' warnings sit in .shared-notice, whose body text was --label-2
// (3.4:1 in light theme). Both lines of the notice have to read at 4.5:1 on the notice's own
// fill and on the sheet behind it, in every theme the notice is drawn in.
describe('Shared notice text (NATG-592)', () => {
  const css = read('index.css')
  const hc = block(css, /@media\s*\(prefers-contrast:\s*more\)/)
  // Every --token the rules declare, later rules winning, as the cascade does for :root.
  const tokens = (...rules) => Object.fromEntries(rules.flatMap((r) => [...r.matchAll(/(--[\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()])))
  const themes = [
    ['dark', tokens(rule(css, ':root')), false],
    ['light', tokens(rule(css, ':root'), rule(css, ':root[data-theme="light"]')), true],
    ['increased-contrast light', tokens(rule(css, ':root'), rule(css, ':root[data-theme="light"]'), rule(hc, ':root'), rule(hc, ':root[data-theme="light"]')), true],
  ]
  const prop = (decls, name) => decls.match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;}]+)`))?.[1]?.trim()
  // A colour as the theme paints it: var() resolved, rgba() kept with its alpha.
  const paint = (value, vars) => {
    while (/^var\(/.test(value)) value = vars[value.match(/^var\((--[\w-]+)\)/)[1]]
    return value.startsWith('rgba') ? rgba(value) : { rgb: hex(value), a: 1 }
  }
  // The first rule that sets the property wins; the title has no colour of its own and inherits.
  const first = (name, ...sels) => sels.map((s) => prop(rule(css, s), name)).find(Boolean)

  it.each(themes)('%s: title and body read at 4.5:1 on the notice and on the sheet', (_t, vars, light) => {
    const sheet = paint((light && prop(rule(css, ':root[data-theme="light"] .sheet'), 'background')) || prop(rule(css, '.sheet'), 'background'), vars)
    expect(sheet.a).toBe(1)
    const fill = over(paint(prop(rule(css, '.shared-notice'), 'background'), vars), sheet.rgb)
    for (const v of ['', '.warn']) {
      const lines = {
        title: first('color', `.shared-notice${v} b`, '.shared-notice b', '.shared-notice', 'body'),
        body: first('color', `.shared-notice${v} span`, '.shared-notice span', '.shared-notice', 'body'),
      }
      for (const [line, colour] of Object.entries(lines)) {
        expect(colour, `${line}${v}`).toBeTruthy()
        const ink = paint(colour, vars)
        for (const [where, bg] of [['notice', fill], ['sheet', sheet.rgb]]) {
          expect(ratio(over(ink, bg), bg), `${line}${v} on the ${where}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

describe('Reduce Transparency (#708)', () => {
  // Every blurred surface in a sheet has to be listed in that sheet's own
  // prefers-reduced-transparency block, with the blur off. A new frosted bar that forgets it
  // stays see-through for the people who asked for less of exactly that.
  it.each(['index.css', 'coach.css'])('%s: no surface keeps its blur', (file) => {
    const css = read(file)
    const reduce = block(css, /@media\s*\(prefers-reduced-transparency:\s*reduce\)/)
    const off = [...reduce.matchAll(/([^{}]+)\{[^}]*(?:^|;)\s*backdrop-filter:none/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    const blurred = [...css.matchAll(/([^{}]+)\{[^}]*backdrop-filter:[^;}]*blur\(/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()))
      .filter((s) => !s.startsWith('@'))
    expect(blurred.length).toBeGreaterThan(0)
    for (const sel of blurred) expect(off, sel).toContain(sel)
  })
})

describe('Secondary text contrast (NATG-644)', () => {
  const css = read('index.css')
  const hc = block(css, /@media\s*\(prefers-contrast:\s*more\)/)
  const dark = rule(css, ':root')
  const light = rule(css, ':root[data-theme="light"]')
  // Every rule whose selector list is exactly `sel`, wherever it sits (top level or in an @media).
  const rules = (src, sel) => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim() === sel).map((m) => m[2])
  const colour = (decls) => decls.match(/(?:^|;)\s*color:\s*([^;}]+)/)?.[1]?.trim()

  it('light --label-2 is .76; the dark and increased-contrast values are unchanged', () => {
    expect(token(light, '--label-2')).toBe('rgba(60,60,67,.76)')
    expect(token(dark, '--label-2')).toBe('rgba(235,235,245,.60)')
    expect(token(rule(hc, ':root'), '--label-2')).toBe('rgba(235,235,245,.78)')
    expect(token(rule(hc, ':root[data-theme="light"]'), '--label-2')).toBe('rgba(60,60,67,.82)')
  })

  it('.dim reads in --label-2', () => {
    expect(rules(css, '.dim').map(colour)).toEqual(['var(--label-2)'])
  })

  // The direct --label-3 text rules the Designer moved. Borders, glyphs and disabled rows stay.
  const moved = {
    'index.css': [
      '#tabbar button', '.measure-input i', '.subrow .subn', '.plateline .moves', '.sethead', '.sidetag',
      '.wday .lbl', '.efftbl .hd .n,.efftbl .hd .f', '.hm-months span', '.hm-legend', '.fends', '.fzones',
      '.steps-list::marker', '.cal-h', '.cal-legend', '.today-row .lbl2', '.exfix-link',
      '.field::placeholder,.input::placeholder', '.effpick .effpick-free .stp .num::placeholder',
    ],
    'coach.css': ['.ob-hint', '.msg-t', '.pcard-wd', '.composer-cap', '.composer textarea::placeholder'],
    'admin.css': ['.adm-group-t', '.adm-log-row .when', '.adm-empty'],
  }
  it.each(Object.entries(moved).flatMap(([f, sels]) => sels.map((s) => [f, s])))('%s: %s is text in --label-2', (file, sel) => {
    const found = rules(read(file), sel).map(colour).filter(Boolean)
    expect(found.length).toBeGreaterThan(0)
    for (const c of found) expect(c).toBe('var(--label-2)')
  })

  it.each(['.item.add-blocked .tt', '.lrow.share-off .lrow-t', '.swpane.del.dis button'])('disabled %s stays on --label-3', (sel) => {
    expect(rules(css, sel).map(colour)).toEqual(['var(--label-3)'])
  })

  it.each(['--surface', '--bg', '--surface-2', '--surface-3'])('light: --label-2 and .dim read at 4.5:1 on %s', (bg) => {
    const under = hex(token(light, bg))
    expect(ratio(over(rgba(token(light, '--label-2')), under), under)).toBeGreaterThanOrEqual(4.5)
    const dim = colour(rules(css, '.dim')[0]).match(/var\((--[\w-]+)\)/)[1]
    expect(ratio(over(rgba(token(light, dim)), under), under)).toBeGreaterThanOrEqual(4.5)
  })

  it('dark: .dim reads at 4.5:1 on --surface', () => {
    const card = hex(token(dark, '--surface'))
    const dim = colour(rules(css, '.dim')[0]).match(/var\((--[\w-]+)\)/)[1]
    expect(ratio(over(rgba(token(dark, dim)), card), card)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Icon-only controls (WCAG 1.4.11)', () => {
  // A control that is only a glyph (or a disc) needs 3:1 against whatever it sits on, so its ink
  // is --label-2. --label-3 is for decorative and disabled marks, and is under 3:1 in both themes.
  const css = read('index.css')
  const themes = [['dark', rule(css, ':root')], ['light', rule(css, ':root[data-theme="light"]')]]

  it.each(themes)('%s: --label-2 reads at 3:1 on every background', (_t, base) => {
    const ink = rgba(token(base, '--label-2'))
    for (const k of ['--bg', '--surface', '--surface-2', '--surface-3']) {
      const bg = hex(token(base, k))
      expect(ratio(over(ink, bg), bg), k).toBeGreaterThanOrEqual(3)
    }
  })

  it.each([
    ['index.css', '.helpbtn'],
    ['index.css', '.conn-x'],
    ['index.css', '.share-check'],
    ['index.css', '.routine-grip'],
    ['index.css', '.plan-handle'],
    ['index.css', '.searchf .clear'],
    ['index.css', '.search .clear'],
    ['views/FocusView.css', '.focus-side-check'],
    ['views/FocusView.css', '.focus-dots button::after'],
  ])('%s: %s paints with --label-2', (file, sel) => {
    const decls = rule(read(file), sel)
    expect(decls).toContain('var(--label-2)')
    expect(decls).not.toContain('--label-3')
  })
})

describe('Focus indicators (WCAG 1.4.11, NATG-617)', () => {
  const css = read('index.css')
  const hc = block(css, /@media\s*\(prefers-contrast:\s*more\)/)
  const dark = rule(css, ':root')
  const light = rule(css, ':root[data-theme="light"]')
  const presets = [...css.matchAll(/:root\[data-accent="(\w+)"\]\s*\{\s*--acc:var\(--(\w+)\);\s*--acc-2:(#\w+)/g)]
  // A preset whose --acc-2 falls short in light gets a ring of its own there.
  const lightRings = Object.fromEntries([...css.matchAll(/:root\[data-theme="light"\]\[data-accent="(\w+)"\]\s*\{\s*--focus-ring:(#\w+)/g)]
    .map((m) => [m[1], m[2]]))
  // The surfaces a ring can sit on.
  const surfaces = {
    dark: ['--bg', '--bg-el', '--surface', '--surface-2', '--surface-3'],
    light: ['--bg', '--bg-el', '--surface', '--surface-2', '--surface-3'],
  }
  // The light search fields are a translucent fill, so their inset ring sits on that fill over
  // whatever is behind the field.
  const searchFill = token(rule(css, ':root[data-theme="light"] .search .input'), 'background')
  const lightGrounds = [
    ...surfaces.light.map((s) => [s, hex(token(light, s))]),
    ...['--bg', '--bg-el', '--surface', '--surface-2'].map((s) => [`search fill over ${s}`, over(rgba(searchFill), hex(token(light, s)))]),
  ]

  it('the ring is the accent in dark and its darker --acc-2 in light', () => {
    expect(token(dark, '--focus-ring')).toBe('var(--acc)')
    expect(token(light, '--focus-ring')).toBe('var(--acc-2)')
    // Orange is the one preset that needs its own; every other preset keeps --acc-2.
    expect(lightRings).toEqual({ orange: '#b36000' })
  })

  it('both light search fields use the translucent fill the contrast checks composite', () => {
    expect(searchFill).toMatch(/^rgba\(/)
    expect(token(rule(css, ':root[data-theme="light"] .searchf .field'), 'background')).toBe(searchFill)
  })

  it('every preset draws its ring at 3:1 or better in both themes, Increase Contrast included', () => {
    expect(presets.length).toBe(8)
    for (const [, name, colour, acc2] of presets) {
      for (const palette of [dark, rule(hc, ':root')]) {
        const ring = hex(token(palette, `--${colour}`))
        for (const s of surfaces.dark) expect(ratio(ring, hex(token(dark, s))), `${name} dark on ${s}`).toBeGreaterThanOrEqual(3)
      }
      const ring = hex(lightRings[name] || acc2)
      for (const [g, rgb] of lightGrounds) expect(ratio(ring, rgb), `${name} light on ${g}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('an own accent colour draws its light ring at 3:1 or better too', () => {
    // A 5-step grid through the sRGB cube, from black to white and every saturated corner.
    const steps = ['00', '40', '80', 'bf', 'ff']
    const sample = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => `#${r}${g}${b}`)))
    for (const c of sample) {
      const ring = hex(customAccentVars(c, 'light')['--acc-2'])
      for (const [g, rgb] of lightGrounds) expect(ratio(ring, rgb), `${c} light on ${g}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('the duration wheel ring reads at 3:1 on its band in both themes', () => {
    // .dw-band is --label at 10% over the sheet; the ring is --label itself, whatever the accent.
    for (const [t, base] of [['dark', dark], ['light', light]]) {
      const ink = hex(token(base, '--label'))
      for (const s of surfaces[t]) {
        const band = over({ rgb: ink, a: 0.1 }, hex(token(base, s)))
        expect(ratio(ink, band), `${t} on ${s}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it.each([
    ['index.css', ':focus-visible', '--focus-ring'],
    ['index.css', '.share-person:focus-visible', '--focus-ring'],
    ['index.css', '.shared-list .item:focus-visible', '--focus-ring'],
    ['index.css', '.field:focus,.input:focus', '--focus-ring'],
    ['coach.css', '.composer textarea:focus', '--focus-ring'],
    ['admin.css', '.adm-kv .v input:focus', '--focus-ring'],
    ['index.css', '.stp:has(.num:focus-visible)', '--focus-ring'],
    ['index.css', '.stp button:focus-visible', '--focus-ring'],
    ['index.css', '.dw-col:focus-visible::after', '--label'],
  ])('%s %s draws in %s', (file, sel, colour) => {
    expect(rule(read(file), sel)).toContain(`var(${colour})`)
  })

  it('a stepper draws its rings where its own clipping leaves them whole (NATG-593)', () => {
    // .stp clips its children, so the field's ring goes on the .stp itself and the − / + draw
    // theirs entirely inside the button: offset inward by at least the ring's own width.
    expect(rule(css, '.stp')).toContain('overflow:hidden')
    expect(rule(css, '.stp .num')).toContain('outline:none')
    expect(rule(css, '.stp:has(.num:focus-visible)')).toMatch(/outline:2\.5px solid var\(--focus-ring\)/)
    const offset = parseFloat(token(rule(css, '.stp button:focus-visible'), 'outline-offset'))
    expect(offset).toBeLessThanOrEqual(-2.5)
  })

  it('a + at its cap dims its icon, not itself, so its ring stays full strength (NATG-593)', () => {
    // opacity on the button would fade its outline with it, to under 3:1.
    expect(rule(css, '.stp button[aria-disabled="true"]')).not.toContain('opacity')
    expect(rule(css, '.stp button[aria-disabled="true"]>*')).toContain('opacity:.32')
  })

  it('no stylesheet draws a focus indicator in the raw accent or a tint of it', () => {
    const sheets = readdirSync(resolve(process.cwd(), 'src'), { recursive: true }).filter((f) => f.endsWith('.css'))
    const focus = sheets.flatMap((f) => [...read(f).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1].includes(':focus'))
      .map((m) => [`${f}: ${m[1].trim()}`, m[2]]))
    expect(focus.length).toBeGreaterThan(0)
    for (const [where, decls] of focus) expect(decls, where).not.toMatch(/var\(--acc(-line|-soft)?\)/)
  })
})
