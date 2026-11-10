import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore, madeHere } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t, tn } from '../lib/i18n.js'
import { DEMO } from '../lib/demo.js'
import { exerciseNameText } from '../lib/format.js'
import { sharingAvailable, sharesOf, sharedWith, customExercisesIn, initials } from '../lib/shares.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Row } from './ui.jsx'
import ShareRoutineSheet from './ShareRoutineSheet.jsx'
import { sharedOverCap } from '../../../api/shared-measure.js'

/**
 * Whom one of your routines is shared with (NATG-485). `available` is false whenever sharing is
 * unavailable (the admin option off, signed out, local mode, the demo), and then nothing else is loaded.
 * `list` is null until GET /api/shares has answered once; `failed` while the last load failed.
 */
export function useRoutineShares(routineId) {
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const shares = useStore(s => s.shares)
  const failed = useStore(s => s.sharesError)
  const available = sharingAvailable(config, user, { demo: DEMO })
  useEffect(() => { if (available) useStore.getState().loadShares() }, [available, user?.id])
  // `mine` may be the last answer kept on this device (useStore SHARED_KEY), which is what the
  // guards go by while the server can't be asked. Kept for this account, it is proof sharing is
  // on (it can't be switched off in v1) until the config has loaded, as on a phone that starts
  // offline; a config the server did answer still decides. `guarded` is the custom-exercise
  // guard's "sharing is on"; `available` stays the share action's, which needs the server anyway.
  const mine = sharesOf(shares, user)
  const guarded = available || (config == null && !!mine)
  return { available, guarded, list: mine && guarded ? sharedWith(mine.outgoing, routineId) : null, failed: available && !mine && failed }
}

// Whether this device's copy of `routine` is over the size cap on shared routines, measured with
// the server's own code (api/shared-measure.js), so the two agree to the byte (NATG-670 AC4). One
// the measure can't read at all is not "too large": the server calls that unreadable, not too-large.
const overCapHere = routine => { try { return sharedOverCap(routine) } catch { return false } }
const stillMotion = () => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

/**
 * Whether the Sharing section shows "too large to share" (NATG-670), and the toast when an edit
 * takes the routine over the cap. Only while it is shared with someone (pending or accepted: an
 * outgoing share carries no state). By this device's measure (`localOver`) or the server's flag on
 * its outgoing shares (`serverOver`, a save from another device, a restored file). While this
 * device has an edit the server's lists haven't answered yet (sync.unsettled) the flag may still
 * be about an older copy, so it goes by its own measure alone: the notice comes and goes with the
 * edit, offline too. The toast is for the moment an edit made here crosses the cap, so the sharer
 * hears of it wherever they are on the page; never on opening the page, a sync or a poll.
 */
function useTooLarge(routine, list, noticeRef) {
  const toast = useUI(s => s.toast)
  const unsettled = useStore(s => !!s.sync?.unsettled)
  const localOver = useMemo(() => overCapHere(routine), [routine])
  const shared = !!list && list.length > 0
  const serverOver = shared && list.some(o => o.unavailable === 'too-large')
  // What the last run saw. Starting from the page's first measure, opening a page already over
  // the cap is no crossing, and neither is opening another routine.
  const seen = useRef({ id: routine.id, over: localOver })
  useEffect(() => {
    const was = seen.current
    seen.current = { id: routine.id, over: localOver }
    if (was.id !== routine.id || was.over || !localOver || !shared) return
    if (!madeHere(useStore.getState().S)) return
    toast(t('This routine is now too large to share.'), {
      action: t('Show'), icon: null,
      onAction: () => {
        const n = noticeRef.current
        if (!n) return
        n.scrollIntoView({ block: 'start', behavior: stillMotion() ? 'auto' : 'smooth' })
        n.focus({ preventScroll: true })
      },
    })
  }, [routine.id, localOver])
  return shared && (localOver || (!unsettled && serverOver))
}

/**
 * The routine page's Sharing section: the share action, or why it is unavailable, and the
 * people the routine is shared with, each with Unshare. Every row offers Unshare whatever that
 * person did with it, since a share they turned down still takes a place under the server's cap
 * until it is unshared (NATG-484). Renders nothing when sharing is unavailable, but
 * for the "too large to share" notice a list kept on this device still calls for (NATG-670).
 */
const RoutineSharing = forwardRef(function RoutineSharing({ routine, S, shares }, ref) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const reasonId = useId()
  const noticeId = useId()
  const noticeRef = useRef(null)
  const [leaving, setLeaving] = useState(() => new Set())   // share ids with an unshare in flight
  const { available, list, failed } = shares
  // `list` is the one kept on this device while the server can't be asked (`guarded`): a phone that
  // starts offline still warns, and still raises the toast on an edit that crosses the cap.
  const tooLarge = useTooLarge(routine, list, noticeRef)
  // Not a live region: the toast announces the crossing once, and this is not read out on every
  // edit while the routine stays over. Focusable for the toast's Show.
  const notice = tooLarge && <div ref={noticeRef} id={noticeId} tabIndex={-1} className="shared-notice warn share-too-large">
    <Icon name="warning" />
    <div>
      <b>{t('People you’ve shared this with won’t be able to open it')}</b>
      <span>{t('It’s too large for a shared routine. Shorten its exercise notes or remove some exercises, and they’ll be able to open it.')}</span>
    </div>
  </div>
  // Sharing unavailable: nothing, unless a list kept here shows the routine is shared and it is
  // too large. Then the heading and the notice alone, since sharing and unsharing need the server.
  if (!available) return notice ? <div ref={ref} tabIndex={-1} className="routine-sharing">
    <section className="sect">
      <h2 className="sect-t">{t('Sharing')}</h2>
      {notice}
    </section>
  </div> : null
  const custom = customExercisesIn(routine, S)
  const names = custom.map(exerciseNameText).join(', ')
  const reload = () => useStore.getState().loadShares()

  const openShare = e => {
    const opener = e?.currentTarget
    openSheet(close => <ShareRoutineSheet routine={routine} already={(list || []).map(o => o.to.id)} close={close} returnFocus={opener}
      onShared={n => { toast(tn('Shared with {0} person.', 'Shared with {0} people.', n)); reload() }} />)
  }
  const unshare = o => {
    const first = String(o.to.name || '').trim().split(/\s+/)[0] || o.to.name
    confirmSheet({
      title: t('Stop sharing with {0}?', o.to.name),
      message: t('{0} leaves {1}’s Shared tab and every day it’s on in their plan. Your routine stays as it is.', routine.name, first),
      confirmText: t('Unshare'), danger: true,
      onConfirm: () => {
        setLeaving(s => new Set(s).add(o.id))
        // Whose unshare this is: an answer that lands after the account changed says nothing, so
        // the recipient's name never shows to whoever is signed in now.
        const uid = useStore.getState().user?.id
        const mine = () => useStore.getState().user?.id === uid
        api('/api/shares/' + encodeURIComponent(o.id), { method: 'DELETE' })
          .then(() => { if (mine()) toast(t('Stopped sharing with {0}.', o.to.name)) })
          // Already gone (revoked on another device): what was asked for is true, so say so.
          .catch(e => { if (mine()) toast(e?.status === 404 ? t('Stopped sharing with {0}.', o.to.name) : t('Couldn’t unshare. Check your connection and try again.')) })
          .finally(() => { if (mine()) reload(); setLeaving(s => { const n = new Set(s); n.delete(o.id); return n }) })
      }
    })
  }

  const shared = list && list.length > 0
  return <div ref={ref} tabIndex={-1} className="routine-sharing">
    <section className="sect">
      <h2 className="sect-t">{t('Sharing')}</h2>
      {notice}
      <div className="sect-b">
        {custom.length
          // Unavailable, but still focusable, with the reason written in the row rather than in a
          // tooltip a finger or a screen reader never finds.
          ? <button type="button" className="lrow share-off" aria-disabled="true" aria-describedby={tooLarge ? `${reasonId} ${noticeId}` : reasonId}>
            <span className="lrow-i" style={{ '--tint': 'var(--surface-3)' }}><Icon name="lock" /></span>
            <span className="lrow-m">
              <span className="lrow-t">{t('Share with people')}</span>
              <span className="lrow-s" id={reasonId}>{custom.length === 1
                ? t('Has a custom exercise ({0}), so it can’t be shared.', names)
                : t('Has custom exercises ({0}), so it can’t be shared.', names)}</span>
            </span>
          </button>
          : <Row icon="people" iconTint="var(--blue)" title={shared ? t('Share with more people') : t('Share with people')} accessory="chevron" onClick={openShare}
            describedBy={tooLarge ? noticeId : undefined} />}
      </div>
      {custom.length > 0
        ? <p className="sect-f">{tn('Swap the custom exercise for one from the library to share this routine.', 'Swap the custom exercises for ones from the library to share this routine.', custom.length)}</p>
        : !shared && <p className="sect-f">{t('They’ll find it in Plan › Shared once they accept. Your changes reach them, and they can’t edit it.')}</p>}
    </section>

    {list == null
      ? <p className="sect-f share-state" role="status">{failed
        ? <>{t('Couldn’t check who has this routine.')} <button type="button" className="share-link" onClick={reload}>{t('Try again')}</button></>
        : t('Checking who has it…')}</p>
      : shared && <section className="sect">
        <h2 className="sect-t">{t('Shared with')}</h2>
        <div className="sect-b">
          {list.map(o => <div key={o.id} className="lrow share-row">
            <span className="share-avatar" aria-hidden="true">{initials(o.to.name)}</span>
            <span className="lrow-m"><span className="lrow-t">{o.to.name}</span></span>
            <button type="button" className="share-unshare" disabled={leaving.has(o.id)}
              aria-label={t('Unshare with {0}', o.to.name)} onClick={() => unshare(o)}>{t('Unshare')}</button>
          </div>)}
        </div>
        <p className="sect-f">{t('They can use it but not edit it, and they see your changes. Unsharing takes it off their plan. Your routine stays as it is.')}</p>
      </section>}
  </div>
})
export default RoutineSharing
