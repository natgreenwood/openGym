import { forwardRef, useEffect, useId, useState } from 'react'
import { useStore } from '../store/useStore.js'
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
  const mine = available ? sharesOf(shares, user) : null
  return { available, list: mine ? sharedWith(mine.outgoing, routineId) : null, failed: available && !mine && failed }
}

/**
 * The routine page's Sharing section: the share action, or why it is unavailable, and the
 * people the routine is shared with, each with Unshare. Every row offers Unshare whatever that
 * person did with it, since a share they turned down still takes a place under the server's cap
 * until it is unshared (NATG-484). Renders nothing when sharing is unavailable.
 */
const RoutineSharing = forwardRef(function RoutineSharing({ routine, S, shares }, ref) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const reasonId = useId()
  const [leaving, setLeaving] = useState(() => new Set())   // share ids with an unshare in flight
  const { available, list, failed } = shares
  if (!available) return null
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
        api('/api/shares/' + encodeURIComponent(o.id), { method: 'DELETE' })
          .then(() => toast(t('Stopped sharing with {0}.', o.to.name)))
          // Already gone (revoked on another device): what was asked for is true, so say so.
          .catch(e => e?.status === 404 ? toast(t('Stopped sharing with {0}.', o.to.name)) : toast(t('Couldn’t unshare. Check your connection and try again.')))
          .finally(() => { reload(); setLeaving(s => { const n = new Set(s); n.delete(o.id); return n }) })
      }
    })
  }

  const shared = list && list.length > 0
  return <div ref={ref} tabIndex={-1} className="routine-sharing">
    <section className="sect">
      <h2 className="sect-t">{t('Sharing')}</h2>
      <div className="sect-b">
        {custom.length
          // Unavailable, but still focusable, with the reason written in the row rather than in a
          // tooltip a finger or a screen reader never finds.
          ? <button type="button" className="lrow share-off" aria-disabled="true" aria-describedby={reasonId}>
            <span className="lrow-i" style={{ '--tint': 'var(--surface-3)' }}><Icon name="lock" /></span>
            <span className="lrow-m">
              <span className="lrow-t">{t('Share with people')}</span>
              <span className="lrow-s" id={reasonId}>{custom.length === 1
                ? t('Has a custom exercise ({0}), so it can’t be shared.', names)
                : t('Has custom exercises ({0}), so it can’t be shared.', names)}</span>
            </span>
          </button>
          : <Row icon="people" iconTint="var(--blue)" title={shared ? t('Share with more people') : t('Share with people')} accessory="chevron" onClick={openShare} />}
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
