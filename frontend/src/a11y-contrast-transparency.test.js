import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
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

// NATG-488: text drawn on an accent tint (--acc-soft) or a status pill's tint reads at 4.5:1, in
// both themes, with and without Increase Contrast, over every surface a tint can sit on. The ink
// colours are the Designer's (AC8); the ratios are measured here, the way the browser paints them.
describe('Text on accent and status tints (NATG-488)', () => {
  const css = read('index.css')
  const hc = block(css, /@media\s*\(prefers-contrast:\s*more\)/)
  const ACCENTS = ['lime', 'sky', 'orange', 'violet', 'pink', 'red', 'teal', 'gold']
  const SURFACES = ['--bg', '--bg-el', '--surface', '--surface-2']
  const decls = (r) => [...r.matchAll(/(--[\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()])
  // The root's custom properties for a theme, mode and accent, in cascade order: by specificity
  // first, then by source order. (:root 0,1,0; the theme, an accent and the media block's two
  // theme rules 0,2,0; a theme and an accent together 0,3,0.)
  const rootVars = (theme, more, accent) => {
    const light = theme === 'light'
    const rules = [
      rule(css, ':root'),
      more && rule(hc, ':root'),
      light && rule(css, ':root[data-theme="light"]'),
      accent && rule(css, `:root[data-accent="${accent}"]`),
      more && !light && rule(hc, ':root:not([data-theme="light"])'),
      more && light && rule(hc, ':root[data-theme="light"]'),
      light && accent && [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1].split(',').map((x) => x.trim()).includes(`:root[data-theme="light"][data-accent="${accent}"]`))
        .map((m) => m[2]).join(';'),
    ]
    return Object.fromEntries(rules.filter(Boolean).flatMap(decls))
  }
  // A colour as painted: var() followed, color-mix() with transparent kept as the colour at that
  // alpha (what mixing with transparent premultiplied comes to), rgba() kept with its alpha.
  const paint = (value, vars) => {
    value = value.trim()
    const v = value.match(/^var\((--[\w-]+)\)$/)
    if (v) return paint(vars[v[1]], vars)
    const m = value.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/)
    if (m) { const c = paint(m[1], vars); return { rgb: c.rgb, a: c.a * m[2] / 100 } }
    return value.startsWith('rgba') ? rgba(value) : { rgb: hex(value), a: 1 }
  }
  // `c` laid over each opaque background. A browser stores the result in 8-bit channels and
  // rounds its own way (Chromium paints some tints a shade darker than rounding to nearest), so
  // every result is kept three ways, unrounded, rounded down and rounded up, and scored by the worst.
  const layer = (c, bgs) => bgs.flatMap((bg) => { const r = over(c, bg); return [r, r.map(Math.floor), r.map(Math.ceil)] })
  const worst = (ink, bgs) => Math.min(...bgs.map((b) => ratio(ink, b)))
  const modes = [['dark', false], ['dark', true], ['light', false], ['light', true]]
  const label = (theme, more) => `${theme}${more ? ' increased contrast' : ''}`
  // The last declaration of `name` in a rule (a plain fallback comes first, color-mix() second).
  const last = (decl, name) => [...decl.matchAll(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;}]+)`, 'g'))].pop()?.[1]?.trim()

  it('the inks are the Designer\'s (AC8), and Increase Contrast sets none', () => {
    const light = { lime: '#006b25', sky: '#0156c9', orange: '#8f4b00', violet: '#813ba2', pink: '#b5002d', red: '#b70010', teal: '#006290', gold: '#9a4400' }
    const dark = { lime: 'var(--acc)', sky: '#73b0ff', orange: 'var(--acc)', violet: '#d892ff', pink: '#ff8c95', red: '#ff8172', teal: 'var(--acc)', gold: 'var(--acc)' }
    for (const k of ACCENTS) {
      expect(rootVars('light', false, k)['--acc-ink'], `light ${k}`).toBe(light[k])
      expect(rootVars('dark', false, k)['--acc-ink'], `dark ${k}`).toBe(dark[k])
    }
    const status = (theme) => Object.fromEntries(['ok', 'warn', 'bad'].map((s) => [s, rootVars(theme, false)[`--${s}-ink`]]))
    expect(status('light')).toEqual({ ok: '#006b26', warn: '#715900', bad: '#b70005' })
    expect(status('dark')).toEqual({ ok: 'var(--green)', warn: 'var(--yellow)', bad: '#ff8172' })
    expect(hc).not.toMatch(/--(acc|ok|warn|bad)-ink/)
  })

  it('with no accent chosen, the root falls back to lime\'s ink (AC9)', () => {
    expect(rootVars('light', false)['--acc-ink']).toBe('#006b25')
    expect(rootVars('dark', false)['--acc-ink']).toBe('var(--acc)')
  })

  const accentCases = modes.flatMap(([theme, more]) => [undefined, ...ACCENTS].map((k) => [label(theme, more), k || 'no accent', theme, more, k]))
  it.each(accentCases)('%s, %s: --acc-ink reads at 4.5:1 on --acc-soft over every surface', (_l, _k, theme, more, k) => {
    const vars = rootVars(theme, more, k)
    const ink = paint('var(--acc-ink)', vars)
    expect(ink.a).toBe(1)
    for (const s of SURFACES) {
      expect(worst(ink.rgb, layer(paint('var(--acc-soft)', vars), [hex(vars[s])])), s).toBeGreaterThanOrEqual(4.5)
    }
  })

  const pillCases = modes.flatMap(([theme, more]) => ['ok', 'warn', 'bad'].map((p) => [label(theme, more), p, theme, more]))
  it.each(pillCases)('%s: .adm-pill.%s reads at 4.5:1 on its tint over every surface', (_l, pill, theme, more) => {
    const decl = rule(read('admin.css'), `.adm-pill.${pill}`)
    const vars = rootVars(theme, more)
    const ink = paint(last(decl, 'color'), vars)
    for (const s of SURFACES) {
      expect(worst(ink.rgb, layer(paint(last(decl, 'background'), vars), [hex(vars[s])])), s).toBeGreaterThanOrEqual(4.5)
    }
  })

  // AC1, AC2, AC5: the text rules on the tint use the ink. Their icons and dots follow the text's
  // colour; .ob-choice's icon and .cal-d's dot set --acc themselves and stay.
  const inked = {
    'admin.css': ['.adm-pill.acc', '.adm-chip-key', '.adm-chips .chip.on'],
    'index.css': ['.btn.tinted', '.tag.acc', '.iconbtn.on-ss', '.conn-bar.quiet .conn-a', '.swhint button', '.cal-d.has',
      '.ss-pos', '.sp-avatar.on', '.efftbl .r.on .n'],
    'coach.css': ['.ob-wd.on', '.ob-chips .chip.on', '.pcard-wd.on', '.recap-state.mix'],
    'views/FocusView.css': ['.focus-badge.plan'],
  }
  it.each(Object.entries(inked).flatMap(([f, sels]) => sels.map((s) => [f, s])))('%s: %s is text in --acc-ink', (file, sel) => {
    expect(last(rule(read(file), sel), 'color')).toBe('var(--acc-ink)')
  })

  it.each(['index.css', 'admin.css', 'coach.css', 'views/FocusView.css'])('%s: no rule puts --acc text on --acc-soft', (file) => {
    const all = [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1].split(',').map((x) => x.trim()), decl: m[2] }))
    const tinted = all.filter((r) => /background(-color)?:\s*var\(--acc-soft/.test(r.decl)).flatMap((r) => r.sels)
    expect(tinted.length).toBeGreaterThan(0)
    for (const r of all) {
      if (last(r.decl, 'color') !== 'var(--acc)') continue
      // the rule itself, or text inside an element that has the tint
      for (const sel of r.sels) expect(tinted.some((t) => sel === t || sel.startsWith(t + ' ')), sel).toBe(false)
    }
  })

  // A background laid over an element that has the tint, with text on it: the text reads at 4.5:1
  // through both layers. Each such rule names the tinted element it sits in.
  const CSS_FILES = ['index.css', 'admin.css', 'coach.css', 'views/FocusView.css']
  const layered = [['admin.css', '.chip.on .adm-chip-key', '.adm-chips .chip.on']]
  const layeredCases = modes.flatMap(([theme, more]) => layered.flatMap(([file, sel, parent]) =>
    [undefined, ...ACCENTS].map((k) => [label(theme, more), sel, k || 'no accent', file, parent, theme, more, k])))
  it.each(layeredCases)('%s: %s reads at 4.5:1 on its layer over the tint, %s', (_l, sel, _k, file, parent, theme, more, k) => {
    const src = read(file)
    const own = (theme === 'light' && rule(src, `:root[data-theme="light"] ${sel}`)) || ''
    const decl = rule(src, sel)
    const vars = rootVars(theme, more, k)
    const colour = last(own, 'color') || last(decl, 'color')
    const ink = paint(colour === 'inherit' ? last(rule(src, parent), 'color') : colour, vars)
    const tint = paint(last(rule(src, parent), 'background'), vars)
    const badge = paint(last(own, 'background') || last(decl, 'background'), vars)
    for (const s of SURFACES) {
      expect(worst(ink.rgb, layer(badge, layer(tint, [hex(vars[s])]))), s).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every rule that lays a background inside a tinted element is measured above', () => {
    const rules = CSS_FILES.flatMap((file) => [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ file, sels: m[1].split(',').map((x) => x.trim().replace(/^:root(\[[^\]]*\])*\s+/, '')), decl: m[2] })))
    const compounds = (sel) => sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean)
    // the element a tinted rule paints, by its own compound selector (`.chip.on` of `.adm-chips .chip.on`)
    const tinted = new Set(rules.filter((r) => /background(-color)?:\s*var\(--acc-soft/.test(r.decl))
      .flatMap((r) => r.sels.map((sel) => compounds(sel).pop())))
    expect(tinted.size).toBeGreaterThan(0)
    // A see-through background lets the tint change what the text sits on; an opaque one (the
    // swipe pane's filled --acc button) hides it, and its text is the filled button's business.
    const seeThrough = (v) => /rgba\(|transparent|var\(--(acc-soft|acc-line|label-[234]|sep)/.test(v || '')
    const found = rules.filter((r) => seeThrough(last(r.decl, 'background') || last(r.decl, 'background-color')))
      .flatMap((r) => r.sels.filter((sel) => compounds(sel).slice(0, -1).some((c) => tinted.has(c))).map((sel) => `${r.file}: ${sel}`))
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(layered.map(([file, sel]) => `${file}: ${sel}`), f).toContain(f)
  })

  // AC10: a colour of the user's own gets its ink from lib/accent.js. Its tint does not change in
  // Increase Contrast mode (the colour is set inline), and neither do the surfaces.
  it.each(['dark', 'light'])('%s: a custom accent\'s ink reads at 4.5:1 on its tint, across the sRGB cube', (theme) => {
    const surfaces = [false, true].flatMap((more) => SURFACES.map((s) => hex(rootVars(theme, more)[s])))
    const colour = fc.integer({ min: 0, max: 0xffffff }).map((n) => '#' + n.toString(16).padStart(6, '0'))
    const corners = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#808080',
      // the Tester's: under 4.5:1 in Chromium when the ink only cleared the tint rounded to nearest
      '#42fc96', '#9ed64b', '#d2013d']
    const check = (c) => {
      const vars = customAccentVars(c, theme)
      const tint = paint(rule(css, ':root').match(/--acc-soft:\s*([^;}]+)/)[1], vars)
      return worst(hex(vars['--acc-ink']), layer(tint, surfaces)) >= 4.5
    }
    for (const c of corners) expect(check(c), c).toBe(true)
    fc.assert(fc.property(colour, check), { numRuns: 4000 })
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
    ['index.css', '.measure-input:has(.num:focus-visible)', '--focus-ring'],
    ['coach.css', '.composer textarea:focus', '--focus-ring'],
    ['admin.css', '.adm-kv .v input:focus', '--focus-ring'],
    ['index.css', '.dw-col:focus-visible::after', '--label'],
  ])('%s %s draws in %s', (file, sel, colour) => {
    expect(rule(read(file), sel)).toContain(`var(${colour})`)
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
