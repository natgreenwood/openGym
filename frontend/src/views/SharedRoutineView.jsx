// A routine shared with you, read-only (NATG-486): /plan/r/shared:<shareId>. No editor, reorder,
// rename, delete-exercise, copy, print or share; the one action is "Remove from my plan". Values
// are in your own weight unit, cardio speed unit and exercise-name language. A share that is not
// available right now shows why instead of its exercises, and keeps its days on your schedule.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exOr } from '../lib/exercises.js'
import { t, exerciseNameFor, exerciseNameClass } from '../lib/i18n.js'
import { exLine } from '../lib/history.js'
import { speedUnitOf } from '../lib/speed.js'
import { glyphOf } from '../lib/glyphs.js'
import { POLICY_NAME } from '../lib/progression.js'
import { loadOfRoutine, rankOf, MUSCLE_NAME } from '../lib/muscles.js'
import { initials } from '../lib/shares.js'
import { routineById, shareIdOf } from '../lib/routine-lookup.js'
import { unavailableOf } from '../lib/shared-routines.js'
import { useSharedRoutines } from '../lib/use-shared-routines.js'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { confirmSheet, exerciseDetailSheet } from '../sheets.jsx'
import { daysOn } from '../components/SharedRoutines.jsx'
import { Thumb } from '../components/Media.jsx'
import Icon from '../components/Icon.jsx'
import BodyMap from '../components/BodyMap.jsx'
import { Button } from '../components/ui.jsx'

const firstName = name => String(name || '').trim().split(/\s+/)[0] || String(name || '')

export default function SharedRoutineView({ id }) {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const toast = useUI(s => s.toast)
  const shared = useSharedRoutines()
  const routine = routineById(S, id, shared)
  const off = routine ? null : unavailableOf(shared, id)
  const [removing, setRemoving] = useState(false)
  // A share that ended (or was never yours) has nothing to show: back to the Shared tab.
  useEffect(() => { if (!routine && !off) nav('/plan') }, [!!routine, !!off])
  if (!routine && !off) return null

  const name = routine?.name || off?.name || t('Shared routine')
  const from = routine?.shared?.from?.name || off?.from || ''
  const first = firstName(from)
  const remove = () => confirmSheet({
    title: t('Remove {0}?', name),
    message: t('It leaves your Shared tab and every day it’s on in your schedule. {0}’s routine isn’t affected, and your logged workouts stay as they are.', first),
    confirmText: t('Remove'), danger: true,
    onConfirm: async () => {
      // The account that asked. If it signed out, or another account signed in, before the server
      // answered, the answer is not for whoever is here now: no toast naming the routine and no
      // move to Plan (NATG-524). The same check the store makes on an account switch (user.id).
      const uid = useStore.getState().user?.id
      const asked = () => useStore.getState().user?.id === uid
      setRemoving(true)
      try {
        await useStore.getState().removeShare(shareIdOf(id))
        if (!asked()) return
        toast(t('{0} is off your plan.', name))
        nav('/plan')
      } catch {
        setRemoving(false)
        if (asked()) toast(t('Couldn’t remove {0}. Check your connection and try again.', name))
      }
    },
  })
  const removeButton = <>
    <div style={{ height: 22 }} />
    <Button variant="danger" disabled={removing} onClick={remove}>{t('Remove from my plan')}</Button>
    <p className="sect-f">{from ? t('{0}’s routine isn’t affected.', first) : t('The original routine isn’t affected.')}</p>
  </>
  const header = <div className="hdr">
    <button className="iconbtn" data-back="/plan" onClick={() => nav('/plan')} aria-label={t('Plan')}><Icon name="chevronLeft" /></button>
    <h1 className="shared-ro-title">{name}</h1>
    <span className={'shared-glyph' + (off ? ' unavail' : '')} aria-hidden="true"><Icon name={off ? 'warning' : glyphOf(routine.emoji)} /></span>
  </div>
  const owner = sub => <div className="lrow shared-owner">
    <span className="share-avatar" aria-hidden="true">{initials(from)}</span>
    <span className="lrow-m"><span className="lrow-t">{from ? t('Shared by {0}', from) : t('Shared with you')}</span>{sub && <span className="lrow-s">{sub}</span>}</span>
    {sub && <Icon name="lock" className="lrow-c" />}
  </div>

  if (off) {
    const days = daysOn(S, id)
    const why = off.reason === 'custom-exercise'
      ? (days.length
        ? t('{0} added a custom exercise to {1}, and shared routines can’t include those. It stays on {2} in your schedule and comes back as soon as {3} removes it.', from, name, days.join(', '), first)
        : t('{0} added a custom exercise to {1}, and shared routines can’t include those. It comes back as soon as {2} removes it.', from, name, first))
      : off.reason === 'too-large'
        ? (first
          ? t('{0} has more sets, drops or exercises than this app can open. It stays in your plan and comes back once {1} makes it smaller.', name, first)
          : t('{0} has more sets, drops or exercises than this app can open. It stays in your plan and comes back once it’s made smaller.', name))
        : t('{0} can’t be read on the server right now. It stays in your plan and comes back once it can be read.', name)
    return <div className="narrow">
      {header}
      <div className="shared-notice warn" role="status"><Icon name="warning" /><div><b>{t('Not available right now')}</b><span>{why}</span></div></div>
      <div className="sect-b">{owner(null)}</div>
      {removeButton}
    </div>
  }

  const load = loadOfRoutine(routine)
  const { worked } = rankOf(load)
  return <div className="narrow">
    {header}
    <div className="sect-b" style={{ marginBottom: 22 }}>
      {owner(t('Read-only. {0}’s changes show up here after the next sync.', first))}
      <div className="lrow">
        <span className="lrow-i"><Icon name="chartLine" /></span>
        <span className="lrow-m"><span className="lrow-t">{t('Progression')}</span></span>
        <span className="lrow-v">{routine.excludeFromProgression ? t('Deload routine') : t(POLICY_NAME[routine.prog || 'linear'] || POLICY_NAME.linear)}</span>
      </div>
    </div>
    <div className="shared-ex-h"><h4 className="sec">{t('Exercises')}</h4><span className="small dim">{routine.ex.length}</span></div>
    {routine.ex.length
      ? <div className="list routine-list">{routine.ex.map((e, i) => {
        const ex = exOr(e.id)
        // A tap opens how to do it; nothing on the row changes the routine.
        return <div key={i} className="item" {...tappable(() => exerciseDetailSheet(ex))}>
          <Thumb ex={ex} />
          <div className="grow" style={{ minWidth: 0 }}><div className={`tt ${exerciseNameClass(ex)}`}>{exerciseNameFor(ex)}</div><div className="ss">{exLine(e, S.unit, speedUnitOf(S))}</div>
            {e.note && <div className="small dim" style={{ marginTop: 2 }}>{e.note}</div>}</div>
          <Icon name="chevronRight" className="chev" />
        </div>
      })}</div>
      : <div className="empty"><div className="ico"><Icon name="dumbbell" /></div>{t('No exercises in this routine yet.')}</div>}
    <p className="sect-f">{t('Weights and speeds are in your units. Tap an exercise for how to do it.')}</p>
    {routine.ex.length > 0 && <div className="card" style={{ marginTop: 12 }}>
      <h2>{t('What this session hits')}</h2>
      <BodyMap load={load} body={S.body} />
      <div className="mchips">{worked.slice(0, 6).map(m => <span key={m} className="mchip">{t(MUSCLE_NAME[m])}</span>)}</div>
    </div>}
    {removeButton}
  </div>
}
