import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Modals, { afterScrollRestore, scrollRestorePending, useBehindSheet } from './Modals.jsx'

const mocks = vi.hoisted(() => {
  const listeners = new Set()
  const state = {
    sheets: [],
    closeSheet(id) {
      state.sheets = state.sheets.filter(sheet => sheet.id !== id)
      listeners.forEach(listener => listener())
    },
  }
  return {
    state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setSheets(sheets) {
      state.sheets = sheets
      listeners.forEach(listener => listener())
    },
  }
})

vi.mock('../store/useUI.js', async () => {
  const React = await import('react')
  const useUI = (selector = state => state) => React.useSyncExternalStore(
    mocks.subscribe,
    () => selector(mocks.state),
    () => selector(mocks.state),
  )
  useUI.getState = () => mocks.state
  return { useUI }
})

let dom
let root
let container
let historyMock
let locationMock

function sheet(id, { locked = false, render = () => React.createElement('div') } = {}) {
  return { id, locked, kind: 'sheet', render }
}

function installDom() {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  dom = parsed.window
  dom.scrollTo = vi.fn()
  globalThis.window = dom
  globalThis.document = dom.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  locationMock = { href: 'https://opengym.test/#/workout' }
  historyMock = { pushState: vi.fn(), go: vi.fn() }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: locationMock })
  Object.defineProperty(globalThis, 'history', { configurable: true, value: historyMock })

  container = document.getElementById('root')
  root = createRoot(container)
}

async function setSheets(sheets) {
  await act(async () => { mocks.setSheets(sheets) })
}

async function popstate() {
  await act(async () => { window.dispatchEvent(new dom.Event('popstate')) })
}

function mouse(target, type, clientY, clientX = 0) {
  const event = new dom.Event(type, { bubbles: true })
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  })
  target.dispatchEvent(event)
}

beforeEach(async () => {
  mocks.state.sheets = []
  installDom()
  await act(async () => { root.render(React.createElement(Modals)) })
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null
  container = null
  dom = null
  vi.restoreAllMocks()
})

describe('Modals sheet history accounting', () => {
  it('does not rewind a real page after back spends a locked FinishSummary entry', async () => {
    const confirm = sheet('confirm')
    const summary = sheet('summary', { locked: true })

    await setSheets([confirm])
    expect(historyMock.pushState).toHaveBeenCalledTimes(1)

    // ConfirmDialog closes and FinishSummary opens in the same batch: length remains one,
    // so the existing pushed entry now belongs to the locked summary.
    await setSheets([summary])
    await popstate()
    expect(mocks.state.sheets).toEqual([summary])

    await act(async () => { mocks.state.closeSheet('summary') })
    expect(historyMock.go).not.toHaveBeenCalled()
  })

  it('pushes and rewinds the exact number of entries for batched sheets', async () => {
    await setSheets([sheet('one'), sheet('two')])
    expect(historyMock.pushState).toHaveBeenCalledTimes(2)

    await setSheets([])
    expect(historyMock.go).toHaveBeenCalledTimes(1)
    expect(historyMock.go).toHaveBeenCalledWith(-2)
  })

  it('closes stacked sheets one entry at a time on back', async () => {
    await setSheets([sheet('one'), sheet('two')])
    await popstate()

    expect(mocks.state.sheets.map(item => item.id)).toEqual(['one'])
    expect(historyMock.pushState).toHaveBeenCalledTimes(2)

    await popstate()
    expect(mocks.state.sheets).toEqual([])
    expect(historyMock.go).not.toHaveBeenCalled()
  })

  it('closes an unlocked sheet on back without rewinding its already-spent entry', async () => {
    await setSheets([sheet('open')])
    await popstate()

    expect(mocks.state.sheets).toEqual([])
    expect(historyMock.go).not.toHaveBeenCalled()
  })

  it('accounts for a moved-on entry even when popstate has no current sheet', async () => {
    await setSheets([sheet('navigating')])
    locationMock.href = 'https://opengym.test/#/home'
    await setSheets([])
    expect(historyMock.go).not.toHaveBeenCalled()

    // This spends the deliberately leaked entry with top === undefined.
    await popstate()

    const locked = sheet('locked', { locked: true })
    await setSheets([locked])
    await popstate()
    await setSheets([])
    expect(historyMock.go).not.toHaveBeenCalled()
  })
})

describe('Modals scroll restoration', () => {
  it('uses the body offset corrected by a workout layout change', async () => {
    await setSheets([sheet('layout')])
    document.body.style.top = '-240px'
    await setSheets([])
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 240)
  })

  it('does not undo a newer workout scroll anchor with its delayed keyboard restore', async () => {
    vi.useFakeTimers()
    try {
      await setSheets([sheet('layout')])
      document.body.style.top = '-800px'
      await setSheets([])
      window.scrollTo.mockClear()
      window.dispatchEvent(new dom.Event('workout-scroll-anchor'))
      await act(async () => { vi.advanceTimersByTime(350) })
      expect(window.scrollTo).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})

describe('Modals mouse dragging', () => {
  it('leaves range sliders opted out of sheet dragging', async () => {
    await setSheets([sheet('slider', {
      render: () => React.createElement('input', { type: 'range' }),
    })])
    const sheetEl = container.querySelector('.sheet')
    const slider = container.querySelector('input[type="range"]')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(slider, 'mousedown', 10)
      mouse(sheetEl, 'mousemove', 150)
      window.dispatchEvent(new dom.Event('mouseup'))
    })

    expect(sheetEl.style.transform).toBe('')
    expect(mocks.state.sheets).toHaveLength(1)
  })

  it('releases a drag when mouseup occurs outside the sheet', async () => {
    // a slow pull: synthetic events fire in the same tick, which would read as a flick
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await setSheets([sheet('drag')])
    const sheetEl = container.querySelector('.sheet')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(sheetEl, 'mousedown', 10)
      now = 300; mouse(sheetEl, 'mousemove', 60)
    })
    expect(sheetEl.style.transform).toBe('translateY(50px)')

    await act(async () => { window.dispatchEvent(new dom.Event('mouseup')) })
    expect(sheetEl.style.transform).toBe('')

    await act(async () => { mouse(sheetEl, 'mousemove', 120) })
    expect(sheetEl.style.transform).toBe('')
    expect(mocks.state.sheets).toHaveLength(1)
  })
})

describe('Modals drag axis lock and dismiss', () => {
  it('ignores a sideways gesture instead of wobbling the sheet', async () => {
    await setSheets([sheet('x')])
    const sheetEl = container.querySelector('.sheet')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(sheetEl, 'mousedown', 10, 10)
      mouse(sheetEl, 'mousemove', 20, 60)
      // once locked to x, even a clearly downward move stays with the horizontal gesture
      mouse(sheetEl, 'mousemove', 120, 70)
      window.dispatchEvent(new dom.Event('mouseup'))
    })
    expect(sheetEl.style.transform).toBe('')
    expect(mocks.state.sheets).toHaveLength(1)
  })

  it('leaves horizontal chip strips to their own scrolling', async () => {
    await setSheets([sheet('chips', {
      render: () => React.createElement('div', { className: 'chips' }, React.createElement('button', { className: 'chip' }, 'a')),
    })])
    const sheetEl = container.querySelector('.sheet')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(container.querySelector('.chip'), 'mousedown', 10)
      mouse(sheetEl, 'mousemove', 150)
      window.dispatchEvent(new dom.Event('mouseup'))
    })
    expect(sheetEl.style.transform).toBe('')
    expect(mocks.state.sheets).toHaveLength(1)
  })

  it('snaps back to zero when the pull reverses instead of scrolling while offset', async () => {
    await setSheets([sheet('rev')])
    const sheetEl = container.querySelector('.sheet')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(sheetEl, 'mousedown', 10)
      mouse(sheetEl, 'mousemove', 110)
    })
    expect(sheetEl.style.transform).toBe('translateY(100px)')

    await act(async () => { mouse(sheetEl, 'mousemove', 5) })
    expect(sheetEl.style.transform).toBe('translateY(0px)')

    await act(async () => { window.dispatchEvent(new dom.Event('mouseup')) })
    expect(sheetEl.style.transform).toBe('')
    expect(mocks.state.sheets).toHaveLength(1)
  })

  it('dismisses on a short but fast flick', async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await setSheets([sheet('flick')])
    const sheetEl = container.querySelector('.sheet')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(sheetEl, 'mousedown', 10)
      now = 20; mouse(sheetEl, 'mousemove', 40)
      now = 60; mouse(sheetEl, 'mousemove', 80)   // 70px in 60ms: ~1 px/ms
      window.dispatchEvent(new dom.Event('mouseup'))
    })
    expect(sheetEl.style.transform).toBe('translateY(110%)')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(mocks.state.sheets).toHaveLength(0)
    vi.useRealTimers()
  })

  it('keeps a short slow pull open', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await setSheets([sheet('slow')])
    const sheetEl = container.querySelector('.sheet')
    sheetEl.scrollTop = 0

    await act(async () => {
      mouse(sheetEl, 'mousedown', 10)
      now = 400; mouse(sheetEl, 'mousemove', 80)
      window.dispatchEvent(new dom.Event('mouseup'))
    })
    expect(sheetEl.style.transform).toBe('')
    expect(mocks.state.sheets).toHaveLength(1)
  })
})

describe('Modals scroll restore on close', () => {
  // The body is pinned while a sheet is open and the page is put back where it was on close.
  // The second, delayed restore exists for one reason — iOS scrolling the page again while the
  // keyboard dismisses — so it must only be armed when the keyboard is actually up (QA C1).
  async function openAndClose() {
    dom.scrollY = 320
    await setSheets([sheet('menu')])
    expect(document.body.style.position).toBe('fixed')
    dom.scrollTo.mockClear()
    await setSheets([])
  }

  it('restores the position once and leaves a scroll the page made afterwards alone', async () => {
    vi.useFakeTimers()
    await openAndClose()
    expect(dom.scrollTo).toHaveBeenCalledTimes(1)
    expect(dom.scrollTo).toHaveBeenCalledWith(0, 320)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(dom.scrollTo).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('restores again after the keyboard dismiss animation when the sheet closed with the keyboard up', async () => {
    vi.useFakeTimers()
    dom.innerHeight = 800
    dom.visualViewport = { height: 460 }
    await openAndClose()
    expect(dom.scrollTo).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(dom.scrollTo).toHaveBeenCalledTimes(2)
    expect(dom.scrollTo).toHaveBeenLastCalledWith(0, 320)
    vi.useRealTimers()
  })
})

// The page behind a sheet is pinned (body fixed, shifted by the scroll position) and put back
// where it was when the sheet goes — in the same commit, so there is no frame at scroll 0.
describe('pinning the page behind a sheet', () => {
  it('pins on open with the scroll position folded in, and restores it on close, three times over', async () => {
    vi.useFakeTimers()
    // the sheet closes with the keyboard still up, so the 350 ms restore is armed too (QA C1)
    dom.innerHeight = 800
    dom.visualViewport = { height: 460 }
    Object.defineProperty(dom, 'scrollY', { configurable: true, value: 343 })
    const rafs = []
    dom.requestAnimationFrame = fn => { rafs.push(fn); return rafs.length }
    await setSheets([sheet('a')])
    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.top).toBe('-343px')
    expect(dom.scrollTo).not.toHaveBeenCalled()
    await setSheets([])
    expect(document.body.style.position).toBe('')
    expect(dom.scrollTo).toHaveBeenCalledTimes(1)              // at once, in the same commit
    expect(dom.scrollTo).toHaveBeenCalledWith(0, 343)
    rafs.forEach(fn => fn())
    expect(dom.scrollTo).toHaveBeenCalledTimes(2)              // again on the next frame (iOS scrolls asynchronously)
    vi.advanceTimersByTime(400)
    expect(dom.scrollTo).toHaveBeenCalledTimes(3)              // and after the keyboard's dismiss animation
    vi.useRealTimers()
  })

  // Rating a set closes the effort picker AND ticks it in one tap, so the superset card's own
  // "bring the partner's row into view" is asked for in the same commit as the restore, and the
  // re-assert overwrote it a few ms later, every time. Anything scrolling for its own reasons
  // waits for the restores, and then has the last word.
  it('hands a scroll of its own over the moment the restores are done, and not a frame before', async () => {
    vi.useFakeTimers()
    dom.innerHeight = 800
    dom.visualViewport = { height: 800 }                       // no keyboard: a menu sheet
    Object.defineProperty(dom, 'scrollY', { configurable: true, value: 974 })
    const rafs = []
    dom.requestAnimationFrame = fn => { rafs.push(fn); return rafs.length }
    await setSheets([sheet('effort-picker')])
    await setSheets([])                                        // the pick closes it and ticks the set
    expect(scrollRestorePending()).toBe(true)

    // The order is the whole point, so record it rather than counting: the handed-over scroll must
    // come STRICTLY after the last restore. Equal-time is a fail; on a phone that is a coin toss.
    const order = []
    dom.scrollTo.mockImplementation(() => order.push('scrollTo'))
    afterScrollRestore(() => order.push('handed over'))
    expect(order).toEqual([])                                  // not while the page is being put back
    rafs.forEach(fn => fn())
    expect(order).toEqual(['scrollTo'])                        // the next-frame re-assert, alone
    vi.advanceTimersByTime(400)
    expect(order).toEqual(['scrollTo', 'handed over'])         // no keyboard, so no late re-assert
    expect(order.indexOf('handed over')).toBeGreaterThan(order.lastIndexOf('scrollTo'))
    expect(scrollRestorePending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(order.at(-1)).toBe('handed over')                   // and nothing undoes it afterwards
    vi.useRealTimers()
  })

  it('hands over after the late re-assert when the sheet closed with the keyboard up', async () => {
    vi.useFakeTimers()
    dom.innerHeight = 800
    dom.visualViewport = { height: 460 }
    Object.defineProperty(dom, 'scrollY', { configurable: true, value: 974 })
    const rafs = []
    dom.requestAnimationFrame = fn => { rafs.push(fn); return rafs.length }
    await setSheets([sheet('effort-picker')])
    await setSheets([])
    const order = []
    dom.scrollTo.mockImplementation(() => order.push('scrollTo'))
    afterScrollRestore(() => order.push('handed over'))
    rafs.forEach(fn => fn())
    vi.advanceTimersByTime(400)
    expect(order).toEqual(['scrollTo', 'scrollTo', 'handed over'])
    vi.useRealTimers()
  })

  it('waits for a second sheet that closes inside the first one\'s window', async () => {
    vi.useFakeTimers()
    Object.defineProperty(dom, 'scrollY', { configurable: true, value: 974 })
    let rafs = []
    dom.requestAnimationFrame = fn => { rafs.push(fn); return rafs.length }
    await setSheets([sheet('one')])
    await setSheets([])
    const order = []
    dom.scrollTo.mockImplementation(() => order.push('scrollTo'))
    afterScrollRestore(() => order.push('handed over'))
    vi.advanceTimersByTime(200)
    await setSheets([sheet('two')])                            // and another one closes
    await setSheets([])
    rafs.forEach(fn => fn()); rafs = []
    vi.advanceTimersByTime(160)                                // past the FIRST deadline
    expect(order).not.toContain('handed over')                 // the sequence moved; so does the queue
    vi.advanceTimersByTime(200)                                // past the second one
    expect(order.at(-1)).toBe('handed over')
    expect(order.indexOf('handed over')).toBeGreaterThan(order.lastIndexOf('scrollTo'))
    vi.advanceTimersByTime(1000)
    expect(order.filter(x => x === 'handed over')).toHaveLength(1)
    vi.useRealTimers()
  })

  // A clock that reads coarse (privacy.resistFingerprinting rounds Date.now to 100 ms) can make
  // the last re-assert look early against the deadline. The hand-over happens there all the same,
  // and nothing asked for after it is left waiting for a close that is over.
  it('hands over on the last re-assert even when the clock reads behind the deadline', async () => {
    vi.useFakeTimers()
    dom.innerHeight = 800
    dom.visualViewport = { height: 800 }
    Object.defineProperty(dom, 'scrollY', { configurable: true, value: 974 })
    dom.requestAnimationFrame = () => 0
    await setSheets([sheet('effort-picker')])
    await setSheets([])
    const ran = vi.fn()
    afterScrollRestore(ran)
    vi.setSystemTime(Date.now() - 100)                         // the clock now reads 100 ms behind
    vi.advanceTimersByTime(360)
    expect(ran).toHaveBeenCalledTimes(1)
    expect(scrollRestorePending()).toBe(false)
    const later = vi.fn()
    afterScrollRestore(later)
    expect(later).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('runs a scroll of its own straight away when no sheet is closing', async () => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)                               // whatever closed earlier is long done
    expect(scrollRestorePending()).toBe(false)
    const ran = vi.fn()
    afterScrollRestore(ran)
    expect(ran).toHaveBeenCalledTimes(1)                       // the plain checkbox tick's path
    vi.useRealTimers()
  })
})

// The scroll-restore window says "the page is being put back, wait your turn". It belongs to the
// close path alone. StrictMode (dev) runs the pin/un-pin layout effect twice when Modals mounts
// with a sheet already open, and the cleanup in between looked exactly like a close, so anything
// waiting on the restore (the superset card's scroll, views/Workout.jsx) sat out 350 ms for a
// page nobody was putting back. In dev only.
describe('the restore window under StrictMode', () => {
  it('is not armed by a sheet opening, and still is by one closing', async () => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)                               // whatever ran earlier is long done
    await act(async () => { root.unmount() })
    root = createRoot(container)
    const rafs = []
    dom.requestAnimationFrame = fn => { rafs.push(fn); return rafs.length }

    // Mounting with a sheet already up is the path StrictMode double-invokes: effect, cleanup,
    // effect, all in the one commit, with the sheet open throughout.
    mocks.state.sheets = [sheet('already-open')]
    await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Modals))) })
    expect(document.body.style.position).toBe('fixed')         // the page is pinned, not restoring

    const onOpen = vi.fn()
    afterScrollRestore(onOpen)
    expect(onOpen).toHaveBeenCalledTimes(1)                    // so a scroll of its own runs now

    await setSheets([])
    const onClose = vi.fn()
    afterScrollRestore(onClose)
    expect(onClose).not.toHaveBeenCalled()                     // and a real close still holds it
    vi.advanceTimersByTime(400)
    expect(onClose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

// jsdom and linkedom do not enforce inert, so these check the attributes that make a browser keep
// Tab and the screen reader inside the top sheet. The real Tab behaviour is checked in a browser.
describe('the page behind an open sheet', () => {
  // The shape App.jsx gives it: the page and the bars beside #modal-root take useBehindSheet(),
  // the toast does not.
  function Host() {
    const behind = useBehindSheet()
    return React.createElement(React.Fragment, null,
      React.createElement('div', { id: 'app', ...behind }, React.createElement('button', null, 'Page')),
      React.createElement('nav', { id: 'tabbar', ...behind }, React.createElement('button', null, 'Tab')),
      React.createElement(Modals),
      React.createElement('div', { id: 'toast', role: 'status' }))
  }
  const behindIsHidden = () => ['app', 'tabbar'].map(id => {
    const el = document.getElementById(id)
    return [el.hasAttribute('inert'), el.getAttribute('aria-hidden')]
  })
  const layers = () => [...document.querySelectorAll('#modal-root > div')]
  const usable = el => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') === null

  beforeEach(async () => {
    await act(async () => { root.render(React.createElement(Host)) })
  })

  it('is left alone while no sheet is open', () => {
    expect(behindIsHidden()).toEqual([[false, null], [false, null]])
  })

  it('goes inert and hidden when a sheet opens, and comes back when the last one closes', async () => {
    await setSheets([sheet('one')])
    expect(behindIsHidden()).toEqual([[true, 'true'], [true, 'true']])
    expect(usable(document.getElementById('toast'))).toBe(true)   // still announces
    expect(layers().map(usable)).toEqual([true])

    await setSheets([])
    expect(behindIsHidden()).toEqual([[false, null], [false, null]])
  })

  it('leaves only the top sheet usable when sheets stack', async () => {
    await setSheets([sheet('one'), sheet('two')])
    expect(layers().map(usable)).toEqual([false, true])
    expect(layers()[0].getAttribute('aria-hidden')).toBe('true')

    // the top one closes: the one under it is the top now, and the page stays out of reach
    await act(async () => { mocks.state.closeSheet('two') })
    expect(layers().map(usable)).toEqual([true])
    expect(behindIsHidden()).toEqual([[true, 'true'], [true, 'true']])

    await act(async () => { mocks.state.closeSheet('one') })
    expect(behindIsHidden()).toEqual([[false, null], [false, null]])
  })

  it('makes bottom sheets and centered dialogs modal dialogs', async () => {
    await setSheets([sheet('bottom'), { ...sheet('confirm'), kind: 'center' }])
    const box = sel => document.querySelector(sel)
    expect([box('.sheet').getAttribute('role'), box('.sheet').getAttribute('aria-modal')]).toEqual(['dialog', 'true'])
    expect([box('.center').getAttribute('role'), box('.center').getAttribute('aria-modal')]).toEqual(['dialog', 'true'])
  })

  it('does not wrap a full-screen viewer, already its own named dialog, in a second one', async () => {
    const render = () => React.createElement('div', { className: 'mviewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' })
    await setSheets([{ ...sheet('viewer', { render }), kind: 'viewer' }])
    expect(document.querySelectorAll('#modal-root [role="dialog"]').length).toBe(1)
    expect(behindIsHidden()).toEqual([[true, 'true'], [true, 'true']])
  })
})

// Focus in and out of a bottom sheet or centred dialog (NATG-552). linkedom has no focus at all, so
// these run on happy-dom, which also does what a browser does with inert: an inert element refuses
// focus. That is what makes the close cases worth having. A sheet's opener sits in the sheet under
// it, or on the page, and both are inert until the commit that removes the top sheet is over.
describe('focus in and out of a sheet', () => {
  let happy
  const h = React.createElement
  const active = () => document.activeElement
  const box = sel => document.querySelector(sel)

  // The page and the bars beside #modal-root take useBehindSheet(), as in App.jsx, so the page's
  // own button is inert while any sheet is open.
  function Host() {
    const behind = useBehindSheet()
    return h(React.Fragment, null,
      h('div', { id: 'app', ...behind }, h('button', { id: 'page-btn' }, 'Open')),
      h('div', { id: 'modals' }, h(Modals)))
  }
  const withButton = (id, label = id) => () => h('button', { id }, label)

  beforeEach(async () => {
    await act(async () => { root.unmount() })
    const { Window } = await import('happy-dom')
    happy = new Window({ url: 'https://opengym.test/' })
    happy.document.body.innerHTML = '<div id="root"></div>'
    happy.scrollTo = vi.fn()
    globalThis.window = happy
    globalThis.document = happy.document
    for (const key of ['HTMLElement', 'Node', 'Element', 'Event']) globalThis[key] = happy[key]
    container = document.getElementById('root')
    root = createRoot(container)
    await act(async () => { root.render(h(Host)) })
  })

  afterEach(async () => {
    if (root) await act(async () => { root.unmount() })
    root = null
    await happy.happyDOM.abort()
  })

  it('moves focus to a bottom sheet when it opens, and back to its opener when it closes', async () => {
    document.getElementById('page-btn').focus()
    await setSheets([sheet('one')])
    expect(active()).toBe(box('.sheet'))
    expect(box('.sheet').getAttribute('tabindex')).toBe('-1')
    expect(box('#app').hasAttribute('inert')).toBe(true)

    await act(async () => { mocks.state.closeSheet('one') })
    expect(active()).toBe(document.getElementById('page-btn'))
  })

  it('does the same for a centred dialog', async () => {
    document.getElementById('page-btn').focus()
    await setSheets([{ ...sheet('confirm'), kind: 'center' }])
    expect(active()).toBe(box('.center'))
    expect(box('.center').getAttribute('tabindex')).toBe('-1')

    await act(async () => { mocks.state.closeSheet('confirm') })
    expect(active()).toBe(document.getElementById('page-btn'))
  })

  it('leaves focus where the sheet put it on opening (an autoFocus field)', async () => {
    const render = () => h('input', { id: 'search', autoFocus: true })
    document.getElementById('page-btn').focus()
    await setSheets([sheet('picker', { render })])
    expect(active()).toBe(document.getElementById('search'))

    // and still knows what opened it
    await act(async () => { mocks.state.closeSheet('picker') })
    expect(active()).toBe(document.getElementById('page-btn'))
  })

  it('hands focus back into the sheet underneath when the top one of a stack closes', async () => {
    const one = sheet('one', { render: withButton('in-one', 'Open two') })
    document.getElementById('page-btn').focus()
    await setSheets([one])
    document.getElementById('in-one').focus()
    await setSheets([one, sheet('two', { render: withButton('in-two') })])
    expect(active()).toBe(document.querySelectorAll('.sheet')[1])

    await act(async () => { mocks.state.closeSheet('two') })
    // the opener is in sheet one, which was inert until this close: focus has landed on it
    expect(active()).toBe(document.getElementById('in-one'))

    await act(async () => { mocks.state.closeSheet('one') })
    expect(active()).toBe(document.getElementById('page-btn'))
  })

  it('falls back to the container of the sheet now on top when the opener has gone', async () => {
    const one = sheet('one', { render: withButton('in-one', 'Open two') })
    await setSheets([one])
    document.getElementById('in-one').focus()
    const two = sheet('two')
    await setSheets([one, two])
    // sheet one re-renders without its button while sheet two is open
    await setSheets([{ ...one, render: () => h('p', null, 'gone') }, two])
    expect(document.getElementById('in-one')).toBe(null)

    await act(async () => { mocks.state.closeSheet('two') })
    expect(active()).toBe(document.querySelector('.sheet'))
    expect(document.querySelectorAll('.sheet').length).toBe(1)
  })

  it('closes without an error when the opener has gone and no sheet is left', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    await setSheets([sheet('one')])
    opener.remove()

    await act(async () => { mocks.state.closeSheet('one') })
    expect(document.querySelector('#modal-root')).toBe(null)
    expect(active()).toBe(document.body)
  })

  it('does not take focus from the top sheet when a sheet under it closes', async () => {
    await setSheets([sheet('one'), sheet('two', { render: withButton('in-two') })])
    document.getElementById('in-two').focus()

    await act(async () => { mocks.state.closeSheet('one') })
    expect(active()).toBe(document.getElementById('in-two'))
  })

  it('does not give focus back to a text field on the page, whose keyboard the sheet put away', async () => {
    const field = document.createElement('input')
    document.getElementById('app').appendChild(field)
    field.focus()
    await setSheets([sheet('one')])
    expect(active()).toBe(box('.sheet'))

    await act(async () => { mocks.state.closeSheet('one') })
    expect(active()).not.toBe(field)
  })

  it('leaves a full-screen viewer to its own focus handling', async () => {
    const render = () => h('div', { className: 'mviewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo', tabIndex: -1 })
    document.getElementById('page-btn').focus()
    await setSheets([{ ...sheet('viewer', { render }), kind: 'viewer' }])
    expect(active()).not.toBe(box('.mviewer'))
  })
})
