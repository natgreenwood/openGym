// Plan's third tab, Shared (NATG-486): the routines other people on this server shared with you.
// Waiting ones first, with Accept and Decline; then the ones you accepted, each opening its
// read-only view (views/SharedRoutineView.jsx). Scheduling happens on Schedule, like your own.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { DEMO } from '../lib/demo.js'
import { DAYS, exCount, weekOrder, weekStartOf, todayISO, fmtDate, isoOf } from '../lib/format.js'
import { dateLocale } from '../lib/i18n-core.js'
import { glyphOf } from '../lib/glyphs.js'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { sharingAvailable } from '../lib/shares.js'
import { sharedPointer } from '../lib/routine-lookup.js'
import { useSharedRoutines } from '../lib/use-shared-routines.js'
import { shareNameOf, shareText } from '../lib/shared-routines.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'
import MiniBodyMap from './MiniBodyMap.jsx'

const firstName = name => shareText(name).trim().split(/\s+/)[0] || shareText(name)
// What a pending card shows, type-checked as sharedRoutineOf does for a routine (SEC-01): the
// server checks these too, and the client renders no share value unchecked all the same.
const pendingName = item => shareNameOf(item) || t('Shared routine')
const senderOf = item => shareText(item?.from?.name)
const countOf = item => (Number.isInteger(item?.preview?.exercises) && item.preview.exercises >= 0 ? item.preview.exercises : null)

/** Whether Plan shows the Shared tab: sharing is on for you, or this device holds shares already. */
export function useSharedTab() {
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const shared = useSharedRoutines()
  const available = sharingAvailable(config, user, { demo: DEMO })
  return { show: available || shared.known, available, waiting: shared.pending.length }
}

/** The weekdays a routine id is on, short, in the order your week runs. */
export function daysOn(S, id) {
  return weekOrder(weekStartOf(S)).filter(d => [].concat(S.week?.[d] || []).includes(id)).map(d => t(DAYS[d]))
}

/** The line under a shared routine that is not available right now. */
export const unavailableLine = u => u.reason === 'custom-exercise'
  ? t('Not available · {0} added a custom exercise', firstName(u.from))
  : u.reason === 'too-large' ? t('Not available · it’s too large to open')
    : t('Not available · it can’t be read right now')

/** The glyph tile of a shared routine: its own glyph with the people badge, or a warning. */
export function SharedGlyph({ routine, unavailable }) {
  if (unavailable) return <span className="lrow-i unavail"><Icon name="warning" /></span>
  return <span className="lrow-i has-badge"><Icon name={glyphOf(routine?.emoji)} /><span className="shared-badge" aria-hidden="true"><Icon name="people" /></span></span>
}

// "09:14 today", or the date: when the lists last came from the server.
function syncedWhen(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const time = new Intl.DateTimeFormat(dateLocale(), { hour: '2-digit', minute: '2-digit' }).format(d)
  return isoOf(d) === todayISO() ? t('{0} today', time) : fmtDate(isoOf(d)) + ' ' + time
}

// What a failed answer says. 404: the share has gone meanwhile (revoked, its routine deleted).
// 409: already answered, on another device; the lists have loaded again, so nothing to say.
function answerError(e, name, accepting) {
  const code = e?.data?.code || e?.code
  if (code === 'share-missing' || e?.status === 404) return t('{0} is no longer shared with you.', name)
  if (code === 'share-state' || e?.status === 409) return null
  return accepting ? t('Couldn’t accept {0}. Check your connection and try again.', name) : t('Couldn’t decline {0}. Check your connection and try again.', name)
}

export default function SharedRoutines({ S }) {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const user = useStore(s => s.user)
  const failed = useStore(s => s.sharesError)
  const offlineSync = useStore(s => s.sync?.offline)
  const shared = useSharedRoutines()
  const { available } = useSharedTab()
  const [busy, setBusy] = useState(null)       // the share id an answer is in flight for
  const [focusId, setFocusId] = useState(null) // the row to move focus to once an accept lands
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  // Opening the tab asks the server again, so what is shown is never older than this visit.
  useEffect(() => { if (available) useStore.getState().loadShares() }, [available, user?.id])
  useEffect(() => {
    if (!focusId) return
    const el = [...document.querySelectorAll('[data-shared-row]')].find(x => x.getAttribute('data-shared-row') === focusId)
    if (el) { el.focus(); setFocusId(null) }
  })
  const offline = !online || !!offlineSync

  const answer = async (item, accepting) => {
    const name = pendingName(item)
    setBusy(item.id)
    try {
      if (accepting) { await useStore.getState().acceptShare(item.id); setFocusId(sharedPointer(item.id)) }
      else await useStore.getState().declineShare(item.id)
    } catch (e) {
      const msg = answerError(e, name, accepting)
      if (msg) toast(msg)
    } finally { setBusy(null) }
  }
  const decline = item => {
    const name = pendingName(item)
    confirmSheet({
      title: t('Decline {0}?', name),
      message: t('It won’t be added to your plan. {0} isn’t told, and can share it with you again later.', firstName(senderOf(item))),
      confirmText: t('Decline'), danger: true,
      onConfirm: () => answer(item, false),
    })
  }

  // Nothing known yet: still loading, or the load failed.
  if (!shared.known) {
    if (failed) return <div className="empty" role="alert">
      <div className="ico"><Icon name="cloudSlash" /></div>{t('Couldn’t load what’s shared with you.')}<br />{t('Check your connection and try again.')}
      <div style={{ marginTop: 12 }}><Button size="sm" variant="tinted" icon="reset" onClick={() => useStore.getState().loadShares()}>{t('Try again')}</Button></div>
    </div>
    return <div className="share-skel" role="status" aria-label={t('Loading')}>
      {[0, 1].map(i => <div key={i} className="share-skel-row"><span /><i style={{ width: i ? '40%' : '60%' }} /></div>)}
    </div>
  }

  const accepted = [
    ...shared.routines.map(r => ({ id: r.id, name: r.name, routine: r })),
    ...shared.unavailable.map(u => ({ id: u.id, name: u.name || t('Shared routine'), unavailable: u })),
  ].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))

  const notice = offline && <div className="shared-notice" role="status">
    <Icon name="cloudSlash" />
    <div><b>{t('You’re offline')}</b>
      <span>{shared.fetchedAt
        ? t('Shared routines are as they were at {0}. You can still schedule and train them.', syncedWhen(shared.fetchedAt))
        : t('You can still schedule and train the shared routines you have.')}</span></div>
  </div>

  if (!shared.pending.length && !accepted.length) return <>
    {notice}
    <div className="empty"><div className="ico"><Icon name="people" /></div>{t('Nothing shared with you yet.')}<br />
      <span className="small">{t('When someone on this server shares a routine with you, it shows up here for you to accept.')}</span></div>
  </>

  return <>
    {notice}
    {shared.pending.length > 0 && <>
      <h4 className="sec" id="shared-waiting">{t('Waiting for you')}</h4>
      <div role="list" aria-labelledby="shared-waiting">{shared.pending.map(item => {
        const name = pendingName(item)
        const from = senderOf(item)
        // A pending share that can't be read has no preview: accepting it would be accepting
        // something you can't see, so only Decline is offered (NATG-487).
        const blind = !item.preview
        const sub = [from ? t('From {0}', from) : '', countOf(item) != null ? exCount(countOf(item)) : ''].filter(Boolean).join(' · ')
        const reason = item.unavailable === 'custom-exercise'
          ? t('It has a custom exercise right now, so it can’t be trained until {0} swaps it out.', firstName(from))
          : blind ? t('It can’t be read right now, so it can’t be accepted yet. You can still decline it.') : ''
        const inFlight = busy === item.id
        return <div key={item.id} role="listitem" className="shared-pending" aria-busy={inFlight || undefined}>
          <div className="shared-pending-top">
            <span className="lrow-i" aria-hidden="true"><Icon name="people" /></span>
            <div className="grow" style={{ minWidth: 0 }}><div className="tt">{name}</div>{sub && <div className="ss">{sub}</div>}</div>
          </div>
          {reason && <div className="shared-reason">{reason}</div>}
          <div className="shared-actions">
            <Button size="sm" disabled={offline || !!busy} aria-label={from ? t('Decline {0} from {1}', name, from) : t('Decline {0}', name)}
              onClick={() => decline(item)}>{t('Decline')}</Button>
            <Button size="sm" variant="primary" disabled={offline || blind || !!busy} aria-label={from ? t('Accept {0} from {1}', name, from) : t('Accept {0}', name)}
              onClick={() => answer(item, true)}>{t('Accept')}</Button>
          </div>
          {offline && <div className="shared-reason">{t('Connect to accept or decline.')}</div>}
        </div>
      })}</div>
    </>}
    {accepted.length > 0 && <>
      <h4 className="sec">{t('Shared with you')}</h4>
      <div className="list shared-list">{accepted.map(a => {
        const from = a.routine?.shared?.from?.name || a.unavailable?.from || ''
        const days = daysOn(S, a.id).join(', ')
        const sub = a.unavailable
          ? unavailableLine(a.unavailable)
          : [from ? t('From {0}', from) : '', exCount(a.routine.ex.length), days].filter(Boolean).join(' · ')
        return <div key={a.id} className="item plan-routine" data-shared-row={a.id} {...tappable(() => nav('/plan/r/' + encodeURIComponent(a.id)))}>
          <SharedGlyph routine={a.routine} unavailable={!!a.unavailable} />
          <div className="grow" style={{ minWidth: 0 }}><div className="tt">{a.name}</div><div className="ss">{sub}</div></div>
          {a.routine && <MiniBodyMap routines={[a.routine]} body={S.body} />}
          <Icon name="chevronRight" className="chev" />
        </div>
      })}</div>
      <p className="sect-f">{t('These follow the owner’s changes and can’t be edited. Add them to a day from Schedule, like your own.')}</p>
    </>}
  </>
}
