import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { t, tn } from '../lib/i18n.js'
import { filterPeople, initials, shareError } from '../lib/shares.js'
import { judgeRoutine } from '../lib/shared-routines.js'
import Icon from './Icon.jsx'
import { Button, SearchField } from './ui.jsx'

// The server takes at most this many recipients in one request (api/server.js MAX_SHARE_RECIPIENTS).
export const MAX_PICK = 20

/**
 * Share one routine with people on this server (NATG-485). A multi-select over
 * GET /api/shares/recipients: the selection survives searching, and someone who already has the
 * routine shows as "Already shared" and can't be picked again. That says a share exists, never
 * whether it was accepted or turned down (epic AC12).
 *
 * Sending is POST /api/shares, all or nothing: on a failure nobody got it, the selection stays,
 * and the button becomes "Try again". `onShared(n)` runs after the sheet has closed.
 * `returnFocus`: what had focus when the sheet opened, given focus back when it goes.
 */
export default function ShareRoutineSheet({ routine, already, close, onShared, returnFocus }) {
  const titleId = useId()
  const [people, setPeople] = useState(null)        // null while loading
  const [loadFailed, setLoadFailed] = useState(false)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState(null)              // { title, message } of the last failed send
  const searchRef = useRef(null)
  const retryRef = useRef(null)
  const has = already instanceof Set ? already : new Set(already || [])
  // False once the sheet has gone: closed, or closed for it when the account changed (useUI). An
  // answer that lands after that is dropped, so nothing of it reaches whoever is signed in now.
  const alive = useRef(true)

  const load = () => {
    setLoadFailed(false)
    return api('/api/shares/recipients')
      .then(r => {
        if (!alive.current) return null
        const users = Array.isArray(r?.users) ? r.users.filter(u => u && u.id) : []
        setPeople(users)
        // Someone picked who has gone since is dropped, not sent.
        setPicked(cur => new Set([...cur].filter(id => users.some(u => u.id === id))))
        return users
      })
      .catch(() => { if (alive.current) setLoadFailed(true); return null })
  }
  useEffect(() => {
    alive.current = true
    load()
    searchRef.current?.focus({ preventScroll: true })
    return () => {
      alive.current = false
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => { if (err) retryRef.current?.focus({ preventScroll: true }) }, [err])

  const toggle = id => {
    if (has.has(id) || sending) return
    setPicked(cur => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_PICK) next.add(id)
      return next
    })
  }
  const send = () => {
    if (!picked.size || sending) return
    setSending(true)
    setErr(null)
    const to = [...picked]
    api('/api/shares', { method: 'POST', body: JSON.stringify({ routineId: routine.id, to }) })
      .then(() => { if (!alive.current) return; close(); onShared?.(to.length) })
      .catch(e => {
        if (!alive.current) return
        const m = shareError(e, routine.name)
        setErr(m)
        if (m.refresh) load()
      })
      .finally(() => { if (alive.current) setSending(false) })
  }

  // Nobody else has a profile here: nothing to pick, so the sheet says so and offers only OK.
  if (people && !people.length) return <div role="dialog" aria-labelledby={titleId}>
    <h3 id={titleId}>{t('Share {0}', routine.name)}</h3>
    <div className="empty share-empty">
      <div className="ico"><Icon name="people" /></div>
      <div>{t('No one else has a profile on this server yet.')}</div>
      <div className="small">{t('When someone joins, you can share with them here.')}</div>
    </div>
    <Button variant="primary" onClick={close}>{t('OK')}</Button>
  </div>

  const shown = people ? filterPeople(people, q) : []
  const full = picked.size >= MAX_PICK
  // A routine past lib/limits.js, or one with a field the app can't read, can still be shared, but
  // the people it reaches are shown it as not available (lib/shared-routines.js judgeRoutine), so
  // the sharer is told first (NATG-503). The body gives judgeRoutine's reason: only a too-large
  // routine has a remedy to offer, an unreadable one may have none in the app (NATG-609).
  // Part of the dialog's description, so it is read when the sheet opens with focus in search.
  const verdict = judgeRoutine(routine)
  const unavailable = verdict !== 'ok'
  const noticeId = titleId + '-limits'
  return <div role="dialog" aria-labelledby={titleId} aria-describedby={unavailable ? noticeId : undefined}>
    <h3 id={titleId} style={{ marginBottom: 6 }}>{t('Share {0}', routine.name)}</h3>
    <div className="muted share-lead">{t('Pick who gets it. They’ll find it in Plan › Shared once they accept.')}</div>
    {unavailable && <div className="shared-notice warn" id={noticeId} style={{ marginBottom: 14 }}>
      <Icon name="warning" />
      <div>
        <b>{t('People you share this with won’t be able to open it')}</b>
        <span>{verdict === 'too-large'
          ? t('It’s too large for a shared routine. You can still share it. Once it has fewer sets or exercises, they’ll be able to open it.')
          : t('Something in it can’t be read in a shared routine. You can still share it.')}</span>
      </div>
    </div>}
    <SearchField ref={searchRef} value={q} placeholder={t('Search people')} aria-label={t('Search people')}
      onChange={e => setQ(e.target.value)} onClear={() => { setQ(''); searchRef.current?.focus() }} />

    {loadFailed && !people
      ? <div className="share-alert" role="alert">
        <Icon name="warning" />
        <div><b>{t('Couldn’t load the people on this server')}</b><span>{t('Check your connection and try again.')}</span></div>
      </div>
      : !people
        ? <div className="share-list share-skel" aria-busy="true">
          <span className="vh" role="status">{t('Loading people')}</span>
          {[140, 110, 160, 96].map(w => <div key={w} className="share-skel-row" aria-hidden="true"><span /><i style={{ width: w }} /></div>)}
        </div>
        : <>
          <div className="share-label">
            <span>{t('People on this server')}</span>
            {picked.size > 0 && <span role="status">{t('{0} selected', picked.size)}</span>}
          </div>
          {shown.length
            ? <div className="share-list" role="group" aria-label={t('People on this server')}>
              {shown.map(u => {
                const locked = has.has(u.id)
                const on = locked || picked.has(u.id)
                const noteId = titleId + '-' + u.id
                return <button key={u.id} type="button" role="checkbox" className="share-person"
                  aria-checked={on} aria-disabled={locked || (!on && full) ? 'true' : undefined}
                  aria-describedby={locked ? noteId : undefined} onClick={() => toggle(u.id)}>
                  <span className="share-avatar" aria-hidden="true">{initials(u.name)}</span>
                  <span className="share-nm"><b>{u.name}</b>{locked && <span id={noteId}>{t('Already shared')}</span>}</span>
                  <span className={'share-check' + (locked ? ' locked' : on ? ' on' : '')} aria-hidden="true"><Icon name="check" /></span>
                </button>
              })}
            </div>
            : <div className="empty share-nomatch"><div className="ico"><Icon name="magnifier" /></div>{t('No one called “{0}” on this server.', q.trim())}</div>}
          {full && <div className="small dim share-note">{t('You can share with up to {0} people at a time.', MAX_PICK)}</div>}
        </>}

    {err && <div className="share-alert" role="alert">
      <Icon name="warning" />
      <div><b>{err.title}</b><span>{err.message}</span></div>
    </div>}

    <div style={{ height: 16 }} />
    {loadFailed && !people
      ? <button ref={retryRef} className="btn primary" onClick={load}>{t('Try again')}</button>
      : <button ref={retryRef} className="btn primary" disabled={!picked.size || sending} onClick={send}>
        {sending ? t('Sharing…') : err ? t('Try again') : picked.size ? tn('Share with {0} person', 'Share with {0} people', picked.size) : t('Share')}
      </button>}
    {people && people.length > 0 && <div className="small dim share-foot">{t('Your later changes reach them. They can’t edit it or share it on.')}</div>}
  </div>
}
