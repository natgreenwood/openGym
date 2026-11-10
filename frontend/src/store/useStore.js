import { create } from 'zustand'
import { api, setRemoteAuth } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { registerCustom, healCustomEx } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { rememberDefaultLang } from '../lib/default-lang.js'
import { guestAllowed } from '../lib/guest.js'
import { sharingAvailable, sharesOf } from '../lib/shares.js'
import { orphanPointers, shareNameOf, sharedNames, sharedViewOf } from '../lib/shared-routines.js'
import { sharedPointer } from '../lib/routine-lookup.js'
import { deleteRoutine } from '../lib/routines.js'
import { setSharedSource } from '../lib/shared-source.js'
import { stateJson } from '../lib/state-json.js'
import { MOBILE, initReminderSync, nativeLoad, nativeSave, onAppActive, readJsonFile, syncReminder, writeAutoBackup, writeJsonFile } from '../lib/mobile.js'
import { initHealthSync, syncHealth, readHealth } from '../lib/health-sync.js'
import { refillIfComplete } from '../lib/rotation.js'
import { liftLegacy } from '../lib/sync-legacy.js'
import { mergeStates, localExtras, stampChange, highestStamp, stampRestore, stampReplace, inUnitOf, keepReset, resetIdsOf, mergeResetIds, entryKey } from '../lib/sync-merge.js'
import { convertStateUnit } from '../lib/units.js'
import { pendingRefCount, settleMedia, loadPending } from '../lib/media-owed.js'
import { referencedHashes } from '../lib/media-refs.js'
import { mediaStore, mediaStoreInUse } from '../lib/media-store.js'
import { countChanges, syncFingerprint } from '../lib/sync-changes.js'
import { saveWorkoutEdit, deleteEditedWorkout } from '../lib/session-edit.js'
import { appBase } from '../lib/app-base.js'
import { linkTokenFromSearch, stripLinkFromUrl } from '../lib/device-link.js'
import { loadRemote, chooseLocal, forgetRemote, connect, normalizeServerUrl, renewToken } from '../lib/remote.js'
import { loadCfAccess } from '../lib/cf-access.js'
import { loadCoachDevice, saveCoachDevice, coachDeviceSettings } from '../lib/coach-device.js'
import { initCoachSchedule } from '../lib/coach-schedule.js'
import { RTL_LANGS } from '../lib/i18n-core.js'
import { DEFAULT_TEMPLATE_ID } from '../lib/structuralBalanceTemplates.js'

import { WC_DEFAULT } from '../lib/workout-controls.js'
import { sanitizeAccent } from '../lib/accent.js'
import { registerExerciseAliases } from '../lib/exercise-aliases.js'

const KEY = 'gym_state_v1'
// Where the saved copy stands with the server: the revision it descends from, and its own `_ts`
// at that moment. `rev` goes back to the server as `baseRev` on every push, so a write over a
// document this device never saw is refused (409) instead of dropping another device's work;
// `ts` tells a pull whether anything changed here since. Each tab keeps its own in memory (`meta`
// in the store); this marker is written beside the saved copy for whichever tab loads it next.
// See pushState/pullState.
const SYNC_KEY = 'gym_sync'
// Which write of the saved copy this is: a tab finds another tab's write by it (persist, joinSaved).
const WID_KEY = 'gym_state_wid'
// Whose copy that write was: the owner (gym_owner) the writing tab held, '' for a guest's. A tab
// joins only a copy written under the owner it holds itself (joinSaved, syncFromSaved).
const WID_OWNER_KEY = 'gym_state_owner'
// Which sign-in or sign-out this browser is on: a token rewritten with each one, the same account
// signing in again included, before the owner key it goes with. A same-account round trip (A, out,
// A) leaves gym_owner where it was; this is what shows it to a boot still waiting (NATG-606).
const OWNER_GEN_KEY = 'gym_owner_gen'
const DIRTY_KEY = 'gym_dirty'          // the saved copy owes the server a change
// An owed copy an older app (v1.3.9) left behind: its first sync stamps what it changed
// (lib/sync-legacy.js), holding the fingerprint that app last agreed on with the server.
const LEGACY_KEY = 'gym_legacy_owed'
const SYNCED_AT_KEY = 'gym_synced_at'  // when this device and the server last held the same copy
const SYNCED_FP_KEY = 'gym_synced_fp'  // a fingerprint of that copy (lib/sync-changes.js)
// Changes a forced sign-out or disconnect kept on this device, by server and account, until it
// reaches that server as that account again. On a phone also a file beside the state mirror.
const STASH_KEY = 'gym_stash'
const STASH_FILE = 'opengym-stash.json'
// The share lists as GET /api/shares last answered (routine sharing, NATG-486), `{ uid, incoming,
// outgoing, etag, fetchedAt }`: never part of `S` and never pushed, kept so the routines shared
// with you stay usable offline at their last-synced version, and so the custom-exercise guards on
// your own shared routines have a last-known list to go by. On a phone also a file, since WebView
// storage can be evicted. Replaced whole on every successful load; wiped on sign-out.
export const SHARED_KEY = 'gym_shared_v1'
const SHARED_FILE = 'opengym-shared.json'
const readSharedSaved = () => { try { const v = JSON.parse(localStorage.getItem(SHARED_KEY)); return v && typeof v === 'object' && v.uid ? v : null } catch { return null } }
// A browser sign-out whose request never reached the server. The session cookie is HttpOnly, so
// only the server's answer to /api/logout takes it out of the browser; until that answer comes,
// boot sends the logout again instead of asking /api/me, which would sign the browser straight
// back in with no passkey or password. Any sign-in replaces the cookie and clears the mark.
const LOGOUT_OWED_KEY = 'gym_logout_owed'
// A sign-in (or a phone's pairing) whose question about this device's own entries has not been
// answered yet (adoptProfile): { uid, rejoined, alwaysAsk }. Until it is, nothing syncs — the copy
// on this device may still be a guest's, and a pull or push in that window used to send it over the
// account's profile (QA, v1.3.9: a phone's one workout replaced the twelve on the server while the
// question was open). Kept in storage so an app killed with the question open asks it again on
// the next start instead of pushing the copy it still holds.
const ADOPT_KEY = 'gym_adopt'
// Reads the mark with no argument, sets or clears it with one. Storage that cannot be read owes nothing.
function logoutOwed(on) {
  try {
    if (on === undefined) return localStorage.getItem(LOGOUT_OWED_KEY) === '1'
    if (on) localStorage.setItem(LOGOUT_OWED_KEY, '1'); else localStorage.removeItem(LOGOUT_OWED_KEY)
  } catch { /* private mode with storage blocked */ }
  return false
}
// Mobile build: whose copy the file mirror (lib/mobile.js, opengym-state.json) holds, and which
// one — { owner, ts }, written after it (saveMirror). A device fact, so never inside S.
const MIRROR_OWNER_FILE = 'opengym-state-owner.json'
const CHECK_MIN_MS = 3000    // rev checks closer together than this are the same event (focus + visibility)
const POLL_MS = 30000        // while the app is open and signed in, ask the server for its revision this often
const AUTO_BACKUP_SOON_MS = 2000   // several photos picked at once make one backup
const SHARES_NEWER_MAX = 5   // requests loadSharesNewer waits through after its own, so a steady stream of refreshes can't hold its caller forever
// Whether `next` has a workout photo or video that `prev` had on none of its workouts.
const workoutMediaHashes = S => (Array.isArray(S?.workouts) ? S.workouts : [])
  .flatMap(w => (Array.isArray(w?.media) ? w.media.map(m => m?.hash).filter(h => typeof h === 'string' && h) : []))
const gainedWorkoutMedia = (prev, next) => {
  const had = new Set(workoutMediaHashes(prev))
  return workoutMediaHashes(next).some(h => !had.has(h))
}
export const DEF = {
  unit: 'kg', restSec: 90, restPauseSec: 15, sound: true, soundOnSilent: false, vibrateOnSilent: false, timerFlash: false, timedSetOvertime: false, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  // The weekly-rate corridor on the body-weight card (#759, lib/bodyweight.js rateCorridor).
  rateGoal: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  // A note per day off (#261): { [iso]: { tag, text, _ts } } (lib/day-notes.js). A noted day is
  // excused from the missed-day nudge; each day merges on its own stamp (lib/sync-merge.js).
  dayNotes: {},
  // Body measurements (#82, #699): one check-in per day; canonical cm, kg or % according to
  // the field's unit (lib/measurements.js); merged like weigh-ins (lib/sync-merge.js).
  measurements: [], measurementEnabled: null, customMeasurements: [],
  queue: null,   // a planner's floating week (lib/queue.js) — via the API, or by this rotation feature (below)
  // The in-app rotation's reusable definition — { id, sequence, label } (lib/rotation.js). Never
  // a live queue: it only ever feeds `queue`, and `queue.rotationId` says the pass is managed here.
  rotation: null,
  // null | 'week' | 'rotation' — which of the two scheduling screens Home/Plan show. A live
  // queue always wins regardless of this (scheduleModeOf, lib/rotation.js): the flag exists only
  // to keep Rotation selected, and the weekday grid hidden, from the moment it's chosen in
  // Settings/Plan through to the first routine being added — there's no queue yet to derive it from.
  scheduleMode: null,
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // Stats activity heatmap metric. Profiles without this key continue to open on time.
  heatmapMetric: 'time',
  // Settings → Units → "Count warm-ups in volume" (#719): off keeps volume to work sets.
  volumeWarmups: false,
  // How the active workout is laid out — 'cards' (one exercise at a time with Prev/Next),
  // 'list' (every exercise stacked and scrollable) or 'compact' (that stack stripped to just
  // names and set rows — no media, tags, notes, last-time or progression line). Purely
  // presentational: profiles written before this setting existed overlay onto DEF and keep the
  // 'cards' behaviour. beginWorkout copies the value onto s.active, so the header ⋮ menu can
  // override it for the running session without touching this saved default.
  workoutView: 'cards',
  // List and Compact fold a finished exercise into one line (Settings → Workout; #241). The
  // workout's Layout menu can flip it for the running session (s.active.collapseCompleted).
  collapseCompleted: false,
  // How the Library, the exercise picker and the muscle explorer show exercises — 'list' (rows
  // with a small thumbnail) or 'cards' (a grid of pictures with the name underneath). Switched
  // by the button in those headers (ExerciseViewToggle); older profiles overlay onto the list.
  exerciseView: 'list',
  // Which controls the workout screen shows besides the sets themselves. The default is the
  // lean layout: one "more" button per exercise and a menu on each set number. Every switch
  // brings one of the old always-visible button groups back (Settings → During a workout).
  wc: { ...WC_DEFAULT },
  // One-time hints already shown to this profile, synced so each shows once per person rather
  // than once per device: { swipeSets: true } after the first swipe-on-sets nudge (Workout.jsx).
  hints: {},
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  // nudge/tone: the missed-workout nudge (lib/nudge.js), opt-in, rides on the reminder.
  reminder: { on: false, time: '08:00', tz: null, nudge: false, tone: 'friendly' }, effort: null, autoBackup: false,
  // Equipment profiles (issue: filter Library/picker/routines by what you actually own —
  // e.g. "Home" vs "Gym" — building on the session-only equipment filter from issue #6).
  equipProfiles: [], activeEquipId: null, equipFilterOn: false,
  // Standing per-exercise notes, keyed by exercise id: the gym-specific facts that are true
  // every time you do the movement ("seat 4, pin 7"). Distinct from a routine's `note`, which
  // belongs to one exercise in one plan, and from a session note, which belongs to one day.
  exNotes: {}, exAliases: {},
  // Favourite exercise ids (issue #6) — sorted to the top of the picker/Library. Personal, so
  // it syncs with the profile but is never part of a shared plan bundle (lib/favourites.js).
  favEx: [],
  // First day of the week as a getDay() index — 1 Monday, 0 Sunday. Monday is the default so
  // every profile written before this setting existed keeps the week it has been looking at.
  // See lib/format.js: nothing reads this field directly, everything goes through the helpers.
  weekStart: 1,
  // Decimals on displayed weights: 1 by default, 2 for anyone loading quarter plates or
  // microplates (issue #139). Display only — nothing is stored or rounded differently.
  wdec: 1,
  // Cardio speed shown in 'kmh' or 'mph'. null follows the weight unit (lb reads mph). Display
  // only as well: every speed is stored in km/h (lib/speed.js).
  speedUnit: null,
  // Per-exercise bar weight overrides, keyed by exercise id, in the profile unit (see
  // lib/bar.js). Personal equipment, so it syncs with the account but never travels in a
  // shared plan. Logged weights stay the total — this only feeds the plate math.
  barWeights: {},
  // Your bars, per unit: { kg: { 'olympic barbell': 15, … }, lb: { … } } (lib/bar.js
  // ownBarDefault). What every exercise of that bar type without its own barWeights entry
  // starts from. Not in DEF on purpose: absent means the built-in bars, and a plain setting
  // like restSec for the sync (stamped as a whole in `edited`).
  // Plate inventory, per unit: { lb: { 45: 1, 35: 1, …, _ts }, kg: { … } } — pairs of each size
  // you own (lib/plates.js), stamped with when the list was last changed so a sync keeps the
  // later one (lib/sync-merge.js). Kept per unit: a 45 lb plate is not a 20.4 kg one, so a unit
  // switch shows the other unit's inventory instead of converting this one. Absent for a unit,
  // or a list with no sizes = the standard set, plenty of each. Display only, like barWeights.
  plates: {},
  // How an exercise is plate-loaded when the equipment does not say, keyed by exercise id:
  // { kind: 'pairs' | 'single' | 'none' | null, _ts } (lib/plates.js loadKindFor). A plate-loaded
  // leg press is 'single'; a barbell you never load plates on is 'none'. Absent or null = derived
  // from the equipment. Stamped like the plate list, for the same reason.
  loadKind: {},
  // What a dumbbell or kettlebell weight means, keyed by exercise id: { mode: 'each' | 'total' |
  // null, _ts } (lib/dumbbells.js). Absent or null = as entered, counted once, which is how every
  // set was read before the choice existed. A routine slot can say its own (cfg.dbLoad).
  dbLoad: {},
  // The dumbbells you own, per unit: { kg: { weights: [3, 6, 8, …], _ts }, lb: { … } }
  // (lib/dumbbells.js). Single bells, lightest first. Kept per unit and stamped like the plates;
  // absent or empty = no list, and dumbbell lifts step by their increment as before.
  dumbbells: {},
  // A machine's own weight stack, keyed by exercise id: { unit, weights: [5, 11.3, 18.1, …], _ts }
  // (lib/dumbbells.js, issue #688). Absent or empty = the increment decides, as before.
  stackWeights: {},
  // Gym check-in cards (see views/CheckIn.jsx). Each is a membership
  // code shown as a QR/barcode at the gym's turnstile — added by typing it, importing a photo
  // of the card, or scanning it. We only ever keep the code's VALUE, never a photo: the image
  // is regenerated from `value` every time it's shown (lib/qr.js). `fmt` is the barcode symbology
  // ('qrcode' | 'ean13' | 'code128' | … — lower-cased BarcodeFormat) so it renders as the same
  // kind of code the gym issued. Just data, so it syncs and backs up like everything else.
  //   [{ id, label, value, fmt }]
  gymCards: [],
  // The card the check-in screen last settled on, so it reopens where you left it (handy when
  // you have more than one gym). Holds a gymCards id, or null before any card exists / is chosen;
  // a stale id (card since removed) is simply ignored by the view.
  lastGymCardId: null,
  // Whether the check-in feature is on at all (Settings toggle). Off hides the Home
  // card and the /checkin route; the saved gymCards stay so turning it back on restores them.
  // Defaults on; an older profile without the key reads as on (`!== false`).
  checkIn: true,
  // Whether the body-weight summary card is shown on Home. Off only hides that card: existing
  // entries, Stats, imports and the separate pre-workout weigh-in flow keep working.
  // Defaults on; an older profile without the key reads as on (`!== false`).
  showWeightCard: true,
  // Whether Start opens the quick weigh-in first (sheets.jsx startFlow, issue #137). Off starts
  // the session straight away; weight can still be logged from Home/Stats. On here, so an
  // older profile without the key reads as on (`!== false`) and keeps the step it had; a profile
  // started from nothing begins with it off (freshState below, v1.3.11): most people weigh in at
  // home in the morning, not at the gym, and the step cost a tap every workout.
  weighIn: true,
  // The connection banner at the top (components/SyncBanner.jsx, #369/#330). Off hides it; a
  // stuck sync then shows as a dot on Home instead. Defaults on; an older profile without the
  // key reads as on (`!== false`).
  connStatus: true,
  // Whether "Share as image" puts this session's muscle map on the card (sheets.jsx
  // ShareWorkoutImage, #453). On by default; absent reads as on (`!== false`).
  shareMap: true,
  // The quiet line a device with no server shows ("On this phone only…", "Guest mode…", #454).
  // That is a choice, not a fault, so its × hides it for good; a real problem still shows the bar.
  // Defaults on; an older profile without the key reads as on (`!== false`).
  connLocal: true,
  // Where a planned session's reps come from (Settings → During a workout, lib/session-start.js):
  // 'plan' opens at the routine's own sets × reps and lets history and progression decide the
  // weight; 'last' carries the reps over from the last session, the way it always worked before,
  // and the weight too for an exercise with progression off (nothing else decides it).
  // Absent reads as 'plan' too, which is what the MCP bridge sees on a raw state file.
  startFrom: 'plan',
  // Where "last time" is read from (Settings → During a workout, lib/history.js lastAcrossRoutines,
  // #770): 'routine' is the routine's own last session of the exercise, as it has been since #216;
  // 'any' is its newest session in any workout. Absent reads as 'routine'.
  lastFrom: 'routine',
  // Per-language choice for translated exercise names: whether the original English name is
  // shown in parentheses next to the translation. Map { '<lang>': boolean }; a missing key
  // (any profile written before this setting existed) reads as shown.
  enParens: {},
  // Per-language choice for translated exercise names: whether the translation is replaced
  // entirely by the original English name. Independent of enParens and keyed by the same base
  // language, so e.g. Italian can keep its parens while German pins names to English. Map
  // { '<lang>': boolean }; a missing key reads as off (translation shown as usual).
  enOnly: {},
  // What the line under an exercise holds today's rows against (#173, views/Workout.jsx): 'last'
  // is the last time in that routine, 'best' the best set of the exercise ever logged. Tapping
  // the line switches it. Absent reads as 'last', the line as it always was.
  logRef: 'last',
  // Structural Balance (views/StructuralBalance.jsx): which built-in ratio template is active,
  // and per-role exercise overrides keyed by `${templateId}:${roleId}` — see
  // lib/structuralBalance.js's overrideKey(). An override (`{ id, _ts }`, `id: null` once
  // cleared) replaces that role's curated exercise-id whitelist with a single user-chosen
  // exercise id; the stamp is what lets a sync keep the choice made last (lib/sync-merge.js).
  balanceTemplate: DEFAULT_TEMPLATE_ID, balanceOverrides: {},
}
const clone = o => JSON.parse(JSON.stringify(o))

// The draft an update() hands its producer: a copy of the state in which each top-level field is
// copied (deep, as clone does) the first time the producer reads or writes it, and every field it
// never touched stays the very object the previous state holds. A ticked set touches `active` and
// little else, so it no longer copies the whole history (a full clone of a 400-workout profile was
// most of the ~200 ms each tick took). The untouched fields are the old state's own objects, which
// nothing mutates (every change goes through a draft like this one), and keeping them means that
// what reads them by identity — the stamps (sync-merge stampChange), the watch's ready sessions,
// a component's selector — sees them as unchanged, which they are. `done()` turns the fields still
// untouched into plain values; until then reading one copies it, as clone() would have.
export function draftOf(prev) {
  const S = {}
  const plain = (k, value) => Object.defineProperty(S, k, { value, writable: true, enumerable: true, configurable: true })
  for (const k of Object.keys(prev)) {
    const v = prev[k]
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
    if (v === null || typeof v !== 'object') { S[k] = typeof v === 'number' && !Number.isFinite(v) ? null : v; continue }
    Object.defineProperty(S, k, {
      enumerable: true, configurable: true,
      get() { const c = clone(v); plain(k, c); return c },
      set(x) { plain(k, x) },
    })
  }
  return {
    S,
    done() {
      for (const k of Object.keys(S)) if (Object.getOwnPropertyDescriptor(S, k)?.get) plain(k, prev[k])
      return S
    },
  }
}

// First run on a device whose language renders right-to-left starts in that language
// rather than English; the boot script in index.html mirrors this check for the
// pre-paint direction. The choice is persisted like any other setting once the user
// picks a language.
const detectedLang = () => {
  try {
    const base = (navigator.language || '').toLowerCase().split('-')[0]
    if (RTL_LANGS.has(base)) return base
  } catch (e) { /* ignore */ }
  return 'en'
}

// A copy started from nothing on this device. `langAuto` marks its language as one nobody has
// picked yet, so the instance's DEFAULT_LANG or the browser's language may set it
// (lib/default-lang.js, #303); picking one in Settings clears it. DEF does not carry the mark:
// merged under a saved copy it would claim that every existing profile never chose.
export function freshState() {
  const s = clone(DEF)
  s.lang = detectedLang()
  s.langAuto = true
  s.weighIn = false
  // Exercise animations: Small (v1.3.11), a thumbnail beside the exercise name that a tap opens,
  // so the first set is on screen without scrolling. DEF stays 'full' for a profile saved before.
  s.gifSize = 'mini'
  return s
}

// A copy that starts over on this device: Reset everything, or another account signing in here.
// It is a new profile like freshState's (weigh-in off, small animations), but in the language
// already on screen, and still marked as never picked when it never was.
export function restartedState(cur) {
  const s = freshState()
  if (cur?.lang) { s.lang = cur.lang; s.langAuto = cur.langAuto === true }
  return s
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      const s = sanitizeAccent(Object.assign(clone(DEF), saved))
      if (!saved.lang) s.lang = detectedLang()
      return s
    }
  } catch (e) { /* ignore */ }
  return freshState()
}

// Whether a copy holds anything of its own worth keeping over another: workouts, routines,
// weigh-ins and custom exercises. A custom exercise is all a new guest may have made — with its
// photo or video, which the server counts as unreferenced until the state that names it lands —
// so a profile created from such a copy takes it at once, like one holding a workout.
const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length || (st.customEx || []).length || (st.measurements || []).length || Object.values(st.exAliases || {}).some(v => Array.isArray(v) && v.length))

// Decide whether a pulled account state may replace the local saved state. A local active workout
// is deliberately carried forward: the server stores completed/saved state, while the in-progress
// session belongs to the device that is currently running it.
export function restoredStateFor(local, remote, dirty = false) {
  if (!remote || (hasData(local) && (dirty || (remote._ts || 0) < (local._ts || 0)))) return null
  const next = sanitizeAccent(Object.assign(clone(DEF), remote))
  if (local.active) next.active = local.active
  return next
}

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null
  let toldTooLarge = false
  let toldNoRoom = false   // the save itself was refused — said once per streak, like the above
  let pushing = null       // the PUT in flight, so a second push waits for it instead of racing it
  let pushAgain = false    // a push asked for while one was in flight — run once more after it, for the account (uid) that asked
  let pulling = null       // the GET /api/data in flight, `{ uid, promise }`: two resume signals for the same user make one request
  let configFetch = null   // the /api/config in flight, so two callers make one request
  let sharesFetch = null   // the /api/shares in flight, `{ uid, promise }`: shared only with a caller for the same user
  // The lists as they were before a stale answer replaced them, `{ uid, lists }`: the fresh answer
  // after it names what went from these, so a revoke the stale one saw first is still told (NATG-502).
  let sharesBefore = null
  // The shares each user is removing, uid → (share id → Removes in flight): each Remove counts
  // itself in before its DELETE is sent and out once the reload it starts has settled, so a load
  // that lands meanwhile, even one the server answered after applying the DELETE, does not name
  // the share as gone (NATG-512). A count, per user, so a retry still out (NATG-521) or another
  // account's Remove (NATG-523) keeps the mark.
  // Not reset in clearLocalSession on purpose: signing out and back in mid-DELETE would bring the toast back.
  const sharesRemoving = new Map()
  let sharesFresh = null   // whose lists were loaded from the server since this page started (a saved copy is not)
  // A load landed before boot was through: `{ uid, known }`, whose lists they were and the pointers
  // their clean-up may judge, run at finishBoot while that account is still this tab's (SEC-04).
  let sweepOwed = null
  const saveShares = v => {
    try { localStorage.setItem(SHARED_KEY, JSON.stringify(v)) } catch { /* full: the lists in memory stand, and load again next time */ }
    if (MOBILE) writeJsonFile(SHARED_FILE, v)
  }
  let pushPending = false  // a change made before boot's pull — pushed once boot is through
  // A replace armed for the next push (replaceState): `{ uid, kind, rev, wid, prepare }`. A backup
  // import's goes against the revision the import's check read (importRead), so a change another
  // device synced while the confirm was open is merged in, not wiped. One with no revision yet (a
  // reset, an import with nothing read and no base) reads the account's profile first and goes
  // against that read (readForReplace). None goes without a base (NATG-533).
  let replaceRev = null
  // The write of a sign-in's adoption over a profile that read as empty (runAdopt): a 409 on it is
  // not merged, it hands the profile that appeared back to the adoption to ask about (adoptRaced).
  // It stays armed, with the sign-in's mark and hold, until it lands or its 409 is handed back: a
  // write that failed on the way leaves the question open, and the next check asks it again
  // (resumeAdoption). Only releaseAdopt, a sign-out or another sign-in clears it before that.
  let adoptWrite = null
  let adoptRaced = null
  let importRead = null    // what importConflict last read: { token, state, rev }
  // Each import, and each media job, is held to the owner it began under (ownerToken). The counter
  // moves with every owner change, another tab's (each gym_owner event) or this tab's own
  // (setUser, a sign-out), so neither outlives a switch, back again included; an import's token
  // once found stale stays stale (importIsCurrent).
  let ownerEpoch = 0
  const staleImports = new WeakSet()
  let lastCheck = 0
  let pollTm = null
  let offlineChanges = false   // a push failed for lack of network — the next one that lands says so
  let backupTm = null      // phone: the auto-backup after workout media changed, on its debounce
  let adoptHold = false    // a sign-in's adoption has not decided yet: no pull, no push (ADOPT_KEY)
  let adopting = null      // the adoptProfile in flight
  let rejoined = false     // the account signing in is the one this copy already belongs to (setUser)
  let pairedBase = null    // mobile build: the address of the paired server, while there is one
  let fpOf = null          // the copy the stored fingerprint was last taken of (confirmed)
  let keeping = null       // phone: the file write of what keepForPrevious set aside, until it lands
  let mirrorQ = Promise.resolve()   // phone: the file mirror's writes, one after the other (saveMirror)
  // The write of the saved copy this tab last read or made, and whose copy it was (joinSaved).
  let seenWid = (() => { try { return localStorage.getItem(WID_KEY) } catch { return null } })()
  let seenOwner = (() => { try { return localStorage.getItem('gym_owner') } catch { return null } })()
  // Another tab signed in or out under this one (the gym_owner storage event below): what this
  // tab holds is no copy of the new owner's, so it writes nothing until it has taken that owner's
  // saved copy as it is (takeSaved).
  let handedOver = false
  const staleUid = 'device-tab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  // A copy that owes the server a change and was never written with a write id was last saved by
  // an app from before this one (v1.3.9), which stamped none of its settings, plan days or notes.
  // Noted now, before this app's first save writes a write id beside it.
  try {
    if (!seenWid && seenOwner && localStorage.getItem(DIRTY_KEY) === '1' && localStorage.getItem(KEY) && !localStorage.getItem(LEGACY_KEY)) {
      let fp = null
      try { fp = JSON.parse(localStorage.getItem(SYNCED_FP_KEY)) } catch { /* no fingerprint: the copy is kept aside instead */ }
      localStorage.setItem(LEGACY_KEY, JSON.stringify({ fp, owner: seenOwner }))
    }
  } catch { /* storage refused: the first sync merges it as before */ }
  const readLegacy = () => { try { return JSON.parse(localStorage.getItem(LEGACY_KEY)) || null } catch { return null } }
  const clearLegacy = () => { try { localStorage.removeItem(LEGACY_KEY) } catch { /* the next sync tries again */ } }

  const readAdopt = () => { try { return JSON.parse(localStorage.getItem(ADOPT_KEY)) || null } catch { return null } }
  const writeAdopt = v => { try { if (v) localStorage.setItem(ADOPT_KEY, JSON.stringify(v)); else localStorage.removeItem(ADOPT_KEY) } catch { /* the hold in memory still stands */ } }
  // The adoption owed by the account signed in now, if there is one.
  const adoptOwed = () => { const m = readAdopt(); const u = get()?.user; return m && u && m.uid === u.id ? m : null }
  // Sync held or not, and the screens told (`sync.held`, status 'held').
  const setHold = on => { adoptHold = on; if (get()?.sync) setSync({ held: on }) }
  // The question is answered: sync as usual from here.
  const releaseAdopt = () => { setHold(false); writeAdopt(null); adoptWrite = null }
  // The marker names the account it was written for (`uid`, see writeSync). One that names nobody,
  // as every marker from before this did, or an account other than the browser's owner is no base
  // at all: the copy takes the first-sync path, a merge at worst (NATG-556). The owner key only
  // ever narrows here; it never vouches for a marker that names no account.
  const readStoredSync = () => {
    try {
      const m = JSON.parse(localStorage.getItem(SYNC_KEY))
      return m && typeof m.uid === 'string' && m.uid === localStorage.getItem('gym_owner') ? m : null
    } catch { return null }
  }
  const storedOwed = () => { try { return localStorage.getItem(DIRTY_KEY) === '1' } catch { return false } }

  /* Where the copy in memory stands with the server: the revision it descends from (`base`, as
     { rev, ts, uid }) and whether it owes the server a change (`owed`). Both belong to the copy, per
     tab. The marker and the dirty flag in localStorage are shared by every tab of the browser:
     a tab left open used to quote the revision ANOTHER tab had just synced, so the server saw a
     current baseRev, took the stale copy without a 409, and the workout logged in the other tab
     was gone (#283); and a tab that owed nothing read another tab's failed push as its own,
     merged where it should have adopted, and brought back what the other tab had just deleted.
     Every copy this store puts in place records where it stands; storage is only where a copy
     loaded fresh (a new tab, a reload) learns it, which is why persist writes them beside it.
     A copy set on the store directly, not through persist, has nothing recorded yet: it takes
     what storage says the first time it is asked, and keeps that. */
  const meta = new WeakMap()
  const metaOf = (S = get().S) => {
    let m = meta.get(S)
    if (!m) { m = { base: readStoredSync(), owed: storedOwed() }; meta.set(S, m) }
    return m
  }
  // The saved copy is not the one in memory: its last write was refused (storage full). The
  // marker and the dirty flag then must not describe the copy in memory, or a restart loads the
  // older saved copy as one in step with a newer revision, calls it synced, and its next push
  // (a conditional one that matches) deletes from the server everything it received meanwhile.
  // Until a write lands again the marker is left out (a restart merges, its first-sync path) and
  // the copy stays owed.
  let storeLag = false
  const saveMarker = base => {
    try {
      if (!base || storeLag) { localStorage.removeItem(SYNC_KEY); return }
      const v = JSON.stringify(base)
      // Unchanged, it is not written again: other tabs react to this key moving (see below).
      if (localStorage.getItem(SYNC_KEY) !== v) localStorage.setItem(SYNC_KEY, v)
    } catch { /* storage refused — the copy in memory still knows */ }
  }
  const saveOwed = owed => { try { if (owed || storeLag) localStorage.setItem(DIRTY_KEY, '1'); else localStorage.removeItem(DIRTY_KEY) } catch { /* as above */ } }
  // `wid`: the write id of the server's document at that revision (api/server.js PUT /api/data):
  // the same `rev` after the server went back in time names a different document.
  // `uid`: the account signed in, whose revision this is. Nobody signed in has no revision of
  // anyone's: the write records no base. mergeInto and doPush hold every copy to it.
  // A base stamped for another account is never replaced or dropped here, whichever path asks (a
  // pull, a sign-in's adoption, an import, a reset): it stays, and doPush refuses the copy. Only
  // a sign-out or a switch clears it (forgetSync).
  const holdsForeignBase = () => { const b = metaOf().base; return !!b && b.uid !== get().user?.id }
  const writeSync = (rev, ts, wid) => {
    if (holdsForeignBase()) return
    const uid = get().user?.id
    const base = uid ? { rev, ts: ts || 0, ...(typeof wid === 'string' ? { wid } : {}), uid } : null
    meta.set(get().S, { ...metaOf(), base })
    saveMarker(base)
  }
  const dropSync = () => { if (holdsForeignBase()) return; meta.set(get().S, { ...metaOf(), base: null }); saveMarker(null) }
  const markOwed = owed => { meta.set(get().S, { ...metaOf(), owed }); saveOwed(owed) }
  // Whether anything here is still on its way to the server: a push that failed, one waiting in
  // the debounce or in flight, a change made while boot was pulling, or a copy changed since the
  // revision it descends from.
  const localChanged = (S = get().S) => { const { base } = metaOf(S); return !!base && (S._ts || 0) > (base.ts || 0) }
  // A sign-in whose question is still open (adoptHold, e.g. its GET failed) holds a copy that has
  // reached no server yet: with any data in it, it is owed, so a sign-out asks and keeps it aside
  // instead of wiping the guest's history and what was logged during the hold.
  const owesOwn = () => metaOf().owed || pushPending || pushTm !== null || !!pushing || localChanged()
  const owes = () => owesOwn() || (adoptHold && hasData(get().S))

  /* The connection as the screens show it (components/SyncBanner.jsx, Settings). The flags are set
     where each outcome is known; `status` is derived from them here, once, so no screen has to
     rank them:
       'local'   no server: a phone in local mode, a guest, nobody signed in
       'auth'    the server refuses this device (a 401), or the phone has lost its pairing
       'offline' the server could not be reached at all (no network, DNS, a timeout)
       'error'   it answered with a failure: 5xx, 403, 413, a page that is not openGym's
       'held'    signed in, but the question about this device's own entries is still open
       'pending' reachable, and a change is still waiting to reach it
       'ok'      this device holds what the server holds
     `pending`: a change is owed and the last attempt did not land. `lastSynced`: when this device
     and the server last held the same copy. `lastError`: { status, code } of the failure behind
     'auth', 'offline' or 'error' (status 0 without an HTTP answer). `server`: the base URL this
     device syncs with, or null on a phone that has none. */
  // 'held': a sign-in's question about this device's own entries is still open (adoptProfile), and
  // nothing syncs until it is answered — said after a failed connection, which is why it is held.
  const statusOf = (x, user) => x.auth ? 'auth' : !user ? 'local' : x.offline ? 'offline' : x.lastError ? 'error' : x.held ? 'held' : x.pending ? 'pending' : 'ok'
  const sameError = (a, b) => (a && b ? a.status === b.status && a.code === b.code : a === b)
  const setSync = patch => {
    const cur = get().sync
    const next = { ...cur, ...patch }
    next.status = statusOf(next, get().user)
    if (Object.keys(next).some(k => (k === 'lastError' ? !sameError(next[k], cur[k]) : next[k] !== cur[k]))) set({ sync: next })
  }
  const isNetworkError = e => e && e.status == null   // fetch itself failed, or gave up: no response at all
  const refused = e => e?.status === 401 || e?.code === 'not-paired'
  // The server answered: whatever was wrong with the connection is over.
  const reached = (extra = {}) => setSync({ offline: false, auth: false, lastError: null, ...extra })
  // What a failed request says about the connection. A refused token and a phone without a
  // pairing are the same thing to the person holding it — the device has to be paired or signed
  // in again, and nothing on it is lost meanwhile.
  const failed = (e, extra = {}) => {
    const lastError = { status: e?.status ?? 0, code: e?.code || (e?.status === 401 ? 'auth' : isNetworkError(e) ? 'network' : 'http') }
    if (refused(e)) setSync({ auth: true, offline: false, lastError, ...extra })
    else if (isNetworkError(e)) setSync({ offline: true, lastError, ...extra })
    else setSync({ offline: false, lastError, ...extra })
  }
  // This device and the server hold the same copy: a push landed, a pull adopted, or a check found
  // that nothing moved on either side. The fingerprint is what signing out counts changes against.
  const confirmed = S => {
    const at = Date.now()
    try {
      localStorage.setItem(SYNCED_AT_KEY, String(at))
      if (fpOf !== S) { localStorage.setItem(SYNCED_FP_KEY, JSON.stringify(syncFingerprint(S))); fpOf = S }
    } catch { /* storage refused — only the count is lost */ }
    reached({ pending: false, lastSynced: at })
  }
  const readFingerprint = () => { try { return JSON.parse(localStorage.getItem(SYNCED_FP_KEY)) } catch { return null } }

  // The server this device syncs with: the paired address on a phone, the page's own origin and
  // subpath (#238) in a browser. null on a phone without one — local mode, or a pairing lost
  // under an earlier version, which kept no address.
  const serverBase = () => {
    if (MOBILE) return pairedBase
    try { return location.origin && location.origin !== 'null' ? location.origin + appBase().replace(/\/$/, '') : null } catch { return null }
  }

  initReminderSync(() => get().S)
  // A phone with its own Coach key runs its automatic reviews itself, while the app is open.
  initCoachSchedule(() => get())
  // What it reads back from the health hub (heart rate, weigh-ins) goes in as any change does.
  initHealthSync(() => get().S, fn => get().update(fn))

  // Mobile build: the file mirror, and beside it whose copy it is and which one (its `_ts`) —
  // restoreFromMirror takes the file back only for that account, and only while the two agree,
  // so a mirror write that failed, or a kill between the two writes, leaves a file that is never
  // taken. One write at a time, each of the copy in the store when its turn comes: a slow write
  // can never land after a later one.
  const saveMirror = () => (mirrorQ = mirrorQ.then(async () => {
    const S = get().S
    let owner = null
    try { owner = localStorage.getItem('gym_owner') } catch { /* unknown — the file is then nobody's */ }
    await nativeSave(S)
    await writeJsonFile(MIRROR_OWNER_FILE, { owner, ts: S._ts || 0 })
  }).catch(() => {}))
  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  // `now` skips the wait and returns the write, for a copy that replaced the last one wholesale.
  const nativePersist = (now = false) => {
    clearTimeout(saveTm)
    saveTm = null
    const write = () => { saveTm = null; syncReminder(get().S); syncHealth(get().S).catch(() => {}); readHealth(() => get().S).catch(() => {}); return saveMirror() }
    if (now) return write()
    saveTm = setTimeout(write, 800)
    return null
  }

  // `_ts` is when this device last changed the data — it decides which copy wins on the next
  // pull (restoredStateFor). A copy merely adopted from the server or the file mirror keeps the
  // stamp it came with: re-stamping a read would make an unchanged copy look newer than a real
  // change made on another device, and push it over that change. A change is never stamped
  // before the revision it builds on: that stamp came from the clock of whichever device wrote
  // it, and with this clock behind, the change looked older than its own base — unchanged — and
  // a pull replaced it with the server's copy.
  /* Two tabs of one browser share the saved copy, and each writes its own copy over it whole. A
     change one tab saved and had not pushed (offline, the server down, a guest who never pushes)
     was gone as soon as the other tab saved anything, or the closed tab's finished workout was:
     no trace in storage, on the server or in the count of changes owed. And a second tab's pull
     wrote its `active: null` over the workout running in the first. So every write of the saved
     copy carries a write id (WID_KEY). A tab that finds another tab's write there joins that copy
     into its own first, the way two devices merge (joinSaved), and a tab told of one by the
     browser (the storage event below) takes it into memory straight away. The running workout
     belongs to the browser, not the tab: it is the saved copy's unless this change touched it. */
  const sameCopy = (a, b) => JSON.stringify({ ...a, _ts: 0 }) === JSON.stringify({ ...b, _ts: 0 })
  const readWid = () => { try { return localStorage.getItem(WID_KEY) } catch { return null } }
  const readOwner = () => { try { return localStorage.getItem('gym_owner') } catch { return null } }
  // Only ever compared for equality, so a fresh token rather than a counter two tabs could both
  // advance to the same value. Storage refusing it leaves the owner check alone, as before.
  const readOwnerGen = () => { try { return localStorage.getItem(OWNER_GEN_KEY) } catch { return null } }
  const bumpOwnerGen = () => { try { localStorage.setItem(OWNER_GEN_KEY, Date.now().toString(36) + Math.random().toString(36).slice(2, 8)) } catch { /* the owner check alone, as before */ } }
  // Whether `uid`, the account a sync request is for, is still this tab's: the one signed in here,
  // and the browser's owner too. Asked before each request goes and again when its answer lands.
  // The owner key is what another tab's sign-out or sign-in writes first, so it has moved even
  // while this tab's storage event for it is still queued and the store names the previous user
  // (NATG-528). Nobody (no uid) is never an account: a request for nobody does not go, and an
  // answer to one is not taken (SEC-02). An answer for anyone else is dropped whole: taken or
  // saved, it put the previous account's copy back into the browser after its sign-out, and
  // persist() then moved seenOwner, so the owner event, once it ran, found nothing to clear; a
  // request sent for them went out under whichever session the browser holds now (SEC-01).
  const answerIsFor = uid => !!uid && get()?.user?.id === uid && readOwner() === uid
  // Whether an owner token (ownerToken) still holds: no owner change since it was taken, and
  // the same account signed in here under its own owner key (answerIsFor), or still nobody under
  // the same owner key. A signed-in token taken while the two disagreed (this tab still names A,
  // the owner key already says B) never holds. An import's confirm stays open for as long as the
  // user takes, and another tab can sign out, switch account or sign in from guest meanwhile
  // (NATG-535); a media upload, download or clean-up can outlive a switch the same way (NATG-537).
  const ownerHolds = tok => tok.epoch === ownerEpoch && (tok.uid
    ? tok.owner === tok.uid && answerIsFor(tok.uid)
    : !get().user && readOwner() === tok.owner)
  // The owner the saved copy was written under; null for a copy saved before this was recorded.
  const readWidOwner = () => { try { return localStorage.getItem(WID_OWNER_KEY) } catch { return null } }
  // The saved copy is the one this tab may join: written under the owner this tab holds. QA
  // 2026-10-06: a sign-out (or another account signing in) wrote its wiped copy while the owner
  // key still named the previous account, a second tab joined its whole in-memory copy into it,
  // and the next guest, or the next profile created there, got the previous account's history.
  const savedIsMine = () => {
    if (readOwner() !== seenOwner) return false
    const tag = readWidOwner()
    return tag === null || tag === (seenOwner || '')
  }
  const readSaved = () => {
    try { const raw = localStorage.getItem(KEY); return raw ? Object.assign(clone(DEF), JSON.parse(raw)) : null } catch { return null }
  }
  // Another tab's copy joined into `mine`; `touched` when this change set the running workout.
  const joinTabs = (mine, theirs, touched) => {
    const merged = Object.assign(clone(DEF), mergeStates(mine, theirs))
    merged.active = touched ? carryActive(mine, merged) : carryActive(theirs, merged)
    return merged
  }
  // `S` with what another tab saved since this one last read or wrote the copy; null when there is
  // nothing to join (the same write, no saved copy, or a copy another account's sign-in replaced).
  const joinSaved = (S, prev) => {
    if (readWid() === seenWid || !savedIsMine()) return null
    const theirs = readSaved()
    if (!theirs) return null
    const touched = JSON.stringify(prev?.active ?? null) !== JSON.stringify(S?.active ?? null)
    const merged = joinTabs(S, theirs, touched)
    return sameCopy(merged, S) ? null : merged
  }

  // A tab whose owner changed under it (another tab signed in or out) does not write: its copy is
  // not the new owner's, and written, it went into that owner's copy, settings and all, and on to
  // the server (QA 2026-10-06). Once the new owner's copy is saved it takes that copy as it is.
  // What it was asked to save was made on the empty copy it holds meanwhile, never on the previous
  // owner's: that small change is kept aside, as "Keep profile as is" keeps a device's copy.
  // The owner key moves first, so a save can find it changed while this tab's event for it is still
  // queued (NATG-530): the save is then the handover, as the event would have made it. That copy
  // is the previous owner's whole copy with the change in it, so nothing of it is kept aside: a
  // sign-out leaves nothing of the account in the browser. An owner that moved to the account this
  // tab is signed in as is not another owner (answerIsFor): the copy is that account's, and is saved
  // as before. What the save would push is guarded on its own (queuePush, doPush). A refused reset
  // or import armed its replace before this save (replaceState): that is dropped with it, or the
  // next owner's next push went out as that replace (NATG-570).
  const refuseStale = S => {
    if (!handedOver) {
      const owner = readOwner()
      // Required, not a leftover: the only place the save and the owner event differ. Fixtures that
      // write gym_owner and then set the user (about 60 store tests) depend on it.
      if (owner === seenOwner || answerIsFor(get()?.user?.id)) return false
      handOver(owner)
      return true
    }
    takeSaved()
    clearTimeout(pushTm)
    pushTm = null
    replaceRev = null
    if (hasData(S)) keepAside(S, t('This device, before signing in'), staleUid).catch(() => {})
    return true
  }
  const persist = (S, push = true, stamp = true) => {
    if (refuseStale(S)) return
    const { base, owed } = metaOf()   // the copy being replaced; the new one stands where it stood
    const joined = joinSaved(S, get()?.S)
    if (joined) S = joined
    // A join holds another tab's changes, which this copy then owes the server too.
    if (stamp || joined) S._ts = Math.max(Date.now(), (base?.ts || 0) + 1, Number(S._ts) || 0)
    // Every copy that enters the store — an edit, a pull, an adoption, a restored backup — has its
    // custom exercises marked as such (#378): one stored without the flag by an older plan import
    // goes out with it on the next push, without a stamp of its own (healCustomEx).
    S.customEx = healCustomEx(S.customEx)
    registerCustom(S.customEx)
    registerExerciseAliases(S.exAliases)
    // A refused write used to take the change with it — Finish looked like it simply did
    // nothing. The copy is kept in memory either way and marked as owed to the server, so a
    // signed-in device still gets it there; and it is said out loud once, because a change that
    // is not on the device is the one thing the screen cannot show on its own.
    let saved = true
    try {
      // The marker goes first: a tab that loads the copy in between gets an older base than the
      // copy's, which costs one merge at worst — never a newer one, which would lose data.
      saveMarker(base)
      localStorage.setItem(KEY, stateJson(S))
      localStorage.setItem(WID_OWNER_KEY, seenOwner || '')
      const wid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      localStorage.setItem(WID_KEY, wid)
      seenWid = wid
      seenOwner = readOwner()
      toldNoRoom = false
      if (storeLag) { storeLag = false; saveMarker(base) }   // the saved copy is this one again
    } catch (e) {
      saved = false
      storeLag = true
      try { localStorage.removeItem(SYNC_KEY) } catch { /* nothing to take back */ }
      if (!toldNoRoom) {
        toldNoRoom = true
        import('./useUI.js')
          .then(({ useUI }) => useUI.getState().toast(t('This device is out of storage: the change is not saved on it. Signed in, it still goes to the server.')))
          .catch(() => {})
      }
    }
    meta.set(S, { base, owed: owed || !saved || (!!joined && storedOwed()) })
    if (!saved) saveOwed(true)
    // The running workout changed (a set ticked, a workout started or finished): on a phone it goes
    // to the file at once rather than after the usual wait. localStorage alone is not enough there:
    // the WebView writes it to disk on its own schedule, and an app killed within that moment (or
    // iOS ending it in the background before the page's timers run again) lost the last set.
    const workoutMoved = MOBILE && JSON.stringify(get()?.S?.active ?? null) !== JSON.stringify(S.active ?? null)
    set({ S })
    // A copy that replaces the last one wholesale and keeps an older stamp — adopted from the
    // server — goes to the file at once. Until it does, the file holds the copy it replaced,
    // which looks newer, and a start in between would take that one back (restoreFromMirror).
    if (MOBILE) nativePersist(!stamp || workoutMoved)
    if (push && get().user) {
      // Before boot has pulled, the copy in hand may be older than the server's: a push now
      // would carry it with a stale (or no) baseRev. It waits for finishBoot.
      if (!get().ready) { pushPending = true; return }
      queuePush()
    }
  }
  // The debounced push, for the account it was queued for: dropped if that account has gone.
  const queuePush = () => {
    const uid = get().user?.id
    clearTimeout(pushTm)
    pushTm = setTimeout(() => { if (answerIsFor(uid)) get().pushState(); else pushTm = null }, 1500)
  }
  // Boot's last step: from here on changes push, and one made during boot goes now.
  // A sweep owed to an account that has left meanwhile is dropped, and boot is through all the
  // same (SEC-04): the store still names that account until this tab hears of the owner change,
  // and the sweep's update() would save that account's whole copy under the new owner.
  const finishBoot = (extra = {}) => {
    set({ ready: true, ...extra })
    if (sweepOwed) {
      const { uid, known } = sweepOwed
      sweepOwed = null
      if (answerIsFor(uid)) get().sweepSharedPointers(null, known)
    }
    if (pushPending && get().user) queuePush()
    pushPending = false
  }

  // A signed-in device shows what the server has. Coming back — to the tab, the window, the app,
  // the network — and every half minute while open, it asks the server for its revision (one
  // small GET) and fetches the document only when the number moved; a change still owed to the
  // server is pushed on the same occasion. A phone that sat in a pocket all afternoon and a
  // desktop tab left open all week used to show, and then push, whatever they last had.
  const checkRev = async (force = false) => {
    if (!get().user || !get().ready || document.visibilityState === 'hidden') return
    if (!force && Date.now() - lastCheck < CHECK_MIN_MS) return
    const uid = get().user.id   // the account the check is for; what its answer starts is for it too (SEC-02)
    lastCheck = Date.now()
    // A sign-in still deciding what becomes of this copy: no check of its own. One whose adoption
    // never ran or did not get through (no server, a pairing that failed on the way to it) runs it
    // here, question and all; one already running is left to answer.
    if (adoptHold) { if (!adopting && adoptOwed()) get().resumeAdoption(); return }
    if (pulling && pulling.uid === get().user?.id) return pulling.promise
    const { base } = metaOf()
    // A copy whose base is another account's is not checked at all (NATG-556): a revision that
    // matched would confirm it, rewriting the synced time and fingerprint for that copy and
    // clearing the error, which stays until a sign-out, a switch or a reload.
    if (base && base.uid !== uid) { refuse('check', base.uid, uid); return }
    if (!base || owes()) return get().pullState()
    try {
      if (!answerIsFor(uid)) return
      const { rev, wid, shares: sharesEtag } = await api('/api/data/rev')
      if (!answerIsFor(uid)) return
      // The share lists moved (a new share, an answer, a revoke, a sharer's edit of a routine
      // shared with you): loaded before the document, so a pointer the document gains from
      // another device is checked against lists at least as new as it (sweepSharedPointers).
      if (typeof sharesEtag === 'string' && sharesEtag !== get().shares?.etag && get().user) await get().loadSharesNewer(sharesEtag)
      if (!answerIsFor(uid)) return
      if (rev !== base.rev || (base.wid && wid && wid !== base.wid)) return get().pullState()
      confirmed(get().S)   // nothing moved on either side
    } catch (e) {
      if (!answerIsFor(uid)) return
      if (isNetworkError(e) || refused(e)) failed(e)
      else return get().pullState()   // a server that lacks the route (older API) — the full pull knows the old protocol
    }
  }
  const schedulePoll = () => {
    clearTimeout(pollTm)
    pollTm = setTimeout(() => { checkRev(); schedulePoll() }, POLL_MS)
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkRev() })
  window.addEventListener('focus', () => checkRev())
  window.addEventListener('pageshow', e => { if (e.persisted) checkRev() })
  window.addEventListener('online', () => checkRev(true))   // also retries a push that failed offline
  onAppActive(() => checkRev())
  schedulePoll()

  // A merge or a push of a copy whose base is not the signed-in account's: nothing is written, not
  // the copy, the marker or the owed flag, and the screens say so (connectionView). Every path
  // that gets here is guarded on its own (answerIsFor), so when this fires it is a bug, and it
  // must be seen. The uids go to the console only.
  const refuse = (op, baseUid, uid) => {
    console.warn(`openGym sync: ${op} refused: the copy's base is for ${baseUid || 'no account'}, the account signed in is ${uid || 'nobody'}`)
    failed({ status: 0, code: 'account-mismatch' })
    return false
  }
  // A server from before revisions (< v1.3.6) answers without one, so a copy synced with it has no
  // base, and its push goes as it always did (doPush). Known only from such an answer for the
  // account signed in, from this server; kept in memory, never stored, and void once the owner
  // or the server changes, so it never lets a copy past doPush's check for anyone else.
  let revless = null
  const noteRevless = (uid, on) => { revless = on ? { uid, epoch: ownerEpoch, server: serverBase() } : null }
  const isRevless = uid => !!revless && revless.uid === uid && revless.epoch === ownerEpoch && revless.server === serverBase()

  // Both copies changed: keep both sides' entries, let the newer copy decide the rest
  // (lib/sync-merge.js), and remember the server's revision so the push that follows is
  // conditional on exactly the document that was merged. The merged copy is stamped — it is a
  // real change this device now holds — while `ts` in the base stays old, so a pull that
  // happens before the push lands still sees it as unsent.
  // Only a copy whose base is the signed-in account's is merged (NATG-556): `false`, with nothing
  // written, for any other, and the caller stops there. A first sync writes its base first.
  const mergeInto = (local, remote, rev) => {
    const { base } = metaOf(local)
    const uid = get().user?.id
    if (base?.uid !== uid || !answerIsFor(uid)) return refuse('merge', base?.uid, uid)
    const ts = base.ts || 0
    // The first merge of an older app's owed copy: what that app changed besides its lists is
    // stamped so the merge keeps it (lib/sync-legacy.js). When that cannot be told, the copy as
    // it was is kept aside before the merge, to be saved from Settings, so nothing is lost.
    const legacy = readLegacy()
    if (legacy && legacy.owner === get().user?.id) {
      const lifted = liftLegacy(local, remote, legacy.fp, Math.max(Date.now(), highestStamp(local) + 1, highestStamp(remote) + 1))
      if (!lifted.resolved) keepAside(local, t('This device, before the update'))
      local = Object.assign(clone(DEF), lifted.state)
    }
    if (legacy) clearLegacy()
    const merged = Object.assign(clone(DEF), mergeStates(local, remote))
    merged.active = carryActive(local, merged)
    // A pass of this app's rotation that the merge left complete (each copy finished a session of
    // it, or one copy's refill lost to the other's older queue) starts its next pass here, as the
    // finish that completed it would have (lib/rotation.js).
    if (refillIfComplete(merged)) merged.edited = { ...(merged.edited || {}), queue: Math.max(Date.now(), highestStamp(merged) + 1) }
    persist(merged, false)
    if (rev == null) dropSync()
    else writeSync(rev, ts, remote?._wid)
    return true
  }
  // The workout running on this device, carried from its copy into the one replacing it — in that
  // copy's unit: a merge or a pull can bring the other device's switch to lb along, and a session
  // left in kg would then log kg numbers under an lb label. A switch that only changed the label
  // (`unitSet.convert === false`) relabels the session as it relabels the history (inUnitOf).
  const carryActive = (from, to) => {
    const a = from?.active || null
    const fu = from?.unit || 'kg', tu = to?.unit || 'kg'
    return !a || fu === tu ? a : inUnitOf({ unit: fu, active: a }, to).active
  }
  // Take the server's copy as this device's own, timestamp and all (see persist).
  const adopt = (next, rev) => { persist(next, false, false); writeSync(rev, next._ts, next._wid); markOwed(false) }

  // A replace with no revision to go against yet reads the account's profile first: a reset takes
  // the names of what it wipes from it (resetIds), an import its removal and add-back records, both
  // through the replace's `prepare`, and the PUT goes against that read, never without a base
  // (NATG-655). A copy with no base of its own stands on the read, as a first sync's merge would
  // record it. false when the read did not land or was overtaken. A replace is one attempt, its
  // read included: one whose read failed is not kept armed, or it went out later over whatever
  // another device wrote meanwhile. The copy stays owed, and goes as an ordinary push against the
  // revision it descends from, whose 409 merges. The read is this account's or nothing.
  const owesRead = uid => !!replaceRev && replaceRev.uid === uid && replaceRev.rev == null
  const readForReplace = async (uid, armed) => {
    const held = metaOf().base
    if (held && held.uid !== uid) return refuse('push', held.uid, uid)
    if (!answerIsFor(uid)) return false
    let res
    try { res = await api('/api/data') }
    catch (e) {
      if (replaceRev === armed) replaceRev = null
      if (!answerIsFor(uid)) return false
      markOwed(true)
      if (isNetworkError(e)) offlineChanges = true
      failed(e, { pending: true })
      return false
    }
    // Another replace armed meanwhile reads for itself; one dropped (a sign-out, a switch) is gone.
    if (!answerIsFor(uid) || replaceRev !== armed) return false
    noteRevless(uid, res?.rev == null)
    if (armed.prepare) armed.prepare(res?.state || null)
    if (!answerIsFor(uid) || replaceRev !== armed) return false
    // A server from before revisions has nothing to go against: the push goes as it always did.
    if (res?.rev == null) { replaceRev = null; return true }
    if (!metaOf().base) writeSync(res.rev, 0, res.state?._wid)
    replaceRev = { ...armed, rev: res.rev, wid: res.state?._wid }
    return true
  }

  const doPush = async (attempt = 0) => {
    const uid = get().user?.id   // whose copy this is; an answer that lands after they have gone is dropped (answerIsFor)
    if (replaceRev && replaceRev.uid !== uid) replaceRev = null   // armed for another account (NATG-570)
    if (owesRead(uid) && !(await readForReplace(uid, replaceRev))) return
    const S = get().S
    const { base } = metaOf()
    // No base: this copy does not know which revision it descends from (a first sync, or a marker
    // from before bases named their account, while the first pull has not landed). It pulls first,
    // and the first-sync path writes the account's base and pushes against it. The copy stays owed
    // meanwhile, and a reset or import armed for this push stays armed for that one. Only a server
    // known to have no revisions takes the push as it is (isRevless).
    if (!base && !isRevless(uid) && answerIsFor(uid)) {
      markOwed(true)
      setSync({ pending: true })   // as a push that did not land: the screens say a change is waiting
      get().pullState()   // not awaited: the push it makes waits for this one to be over (pushing)
      return
    }
    // A replace is one attempt. One that fails is retried as an ordinary push against the
    // revision this copy descends from: kept armed, it went out later against a revision older
    // than whatever another device had written in the meantime.
    const asReplace = replaceRev
    replaceRev = null
    const adoption = adoptWrite?.uid === uid
    // `stamped`: this client stamps its own changes; the server stamps only for one that does not
    // (api/sync-stamps.js).
    // An older app's owed copy over the revision it read: the server stamps what that app changed
    // against the copy it holds, exactly as it would for that app (api/sync-stamps.js).
    const legacy = readLegacy()
    const body = { state: S, stamped: !(legacy && legacy.owner === get().user?.id) }
    if (asReplace != null) { body.baseRev = asReplace.rev; if (asReplace.wid) body.baseWid = asReplace.wid }
    else if (base) { body.baseRev = base.rev; if (base.wid) body.baseWid = base.wid }
    if (!answerIsFor(uid)) return   // its account has gone: nothing goes out for it
    // A base that is not this account's: nothing goes out, and nothing here changes (NATG-556).
    if (base && base.uid !== uid) return refuse('push', base.uid, uid)
    try {
      const r = await api('/api/data', { method: 'PUT', body: JSON.stringify(body) })
      if (!answerIsFor(uid)) return
      noteRevless(uid, r.rev == null)
      // A server from before revisions answers without one — then there is nothing to hold the
      // next push to, and the marker must not pretend otherwise.
      if (r.rev == null) dropSync()
      else writeSync(r.rev, S._ts, r.wid)
      // The adoption's write landed: its question is settled, and the sign-in's mark goes.
      if (adoption) { adoptWrite = null; writeAdopt(null) }
      if (legacy) clearLegacy()
      markOwed(false)
      toldTooLarge = false
      confirmed(S)
      // Back from offline with changes that were waiting: say so once — the banner that promised
      // "syncs when you're back online" has just kept its word.
      if (offlineChanges) {
        offlineChanges = false
        import('./useUI.js').then(({ useUI }) => useUI.getState().toast(t('Back online and synced with the server.'))).catch(() => {})
      }
    } catch (e) {
      if (!answerIsFor(uid)) return   // a 409 would merge the previous account's document in
      // A sign-in's adoption wrote over a profile that read as empty, and one has appeared since
      // (another device, another tab). Merged, this copy would win its settings and add its entries
      // to a profile nobody was asked about: it goes back to the adoption instead, held again before
      // anything else can sync, and the adoption asks about it (runAdopt).
      if (adoption && e.status === 409 && e.data?.state) {
        adoptWrite = null
        adoptRaced = { uid, state: e.data.state, rev: e.data.rev || 0 }
        setHold(true)
        return
      }
      // Any other failure of that write (no network, a server error) settles nothing: held again,
      // with the sign-in's mark still there, so no ordinary push can take its place. The next check
      // runs the adoption again from a fresh read (checkRev, resumeAdoption), and a profile that
      // appeared meanwhile is asked about, never merged unasked (NATG-655).
      if (adoption) setHold(true)
      if (e.status === 409 && e.data && attempt < 2) {
        // Another device wrote since this one last read. The server sent its document along;
        // merge and push once more against that revision. A second refusal in a row leaves the
        // copy owed and the next resume pull takes it from there. A backup import or a reset whose
        // replace met another device's sync keeps that device's changes too, and says so, each in
        // its own words.
        if (asReplace != null) {
          const said = asReplace.kind === 'reset'
            ? t('Another device synced while you were resetting, so what it added since was kept.')
            : t('Another device synced while you were importing, so its changes were kept next to the backup.')
          import('./useUI.js')
            .then(({ useUI }) => useUI.getState().toast(said))
            .catch(() => {})
        }
        if (!mergeInto(get().S, e.data.state, e.data.rev || 0)) return
        return doPush(attempt + 1)
      }
      // Whatever went wrong — no network, a refused token, a phone without a pairing, a server
      // error — the copy stays owed to the server and the next check retries it.
      markOwed(true)
      if (isNetworkError(e)) offlineChanges = true
      failed(e, { pending: true })
      // A 413 comes from the proxy in front of the API (nginx: client_max_body_size), which
      // caps the request body. Every later push is at least as big, so nothing reaches the
      // server until the limit is raised — said once per refusal streak; the owed copy keeps
      // the retries going. useUI imports this store, hence the lazy import.
      if (e.status === 413 && !toldTooLarge) {
        toldTooLarge = true
        import('./useUI.js')
          .then(({ useUI }) => useUI.getState().toast(t('Sync failed: the server refused the upload as too large. Your changes have not reached the server.')))
          .catch(() => {})
      }
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  const flush = () => {
    if (MOBILE && saveTm) nativePersist(true)
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
  window.addEventListener('pagehide', flush)   // Safari kills the home-screen app without a visibilitychange at times
  // The phone app: Capacitor's own "going to the background" too, in case the WebView's
  // visibilitychange comes late or not at all before iOS suspends the page.
  document.addEventListener('pause', flush)

  // The owner check in setUser only runs in the tab that signs in. Another tab of the same
  // browser still holding the previous profile, or a guest's copy, would keep writing it over the
  // shared copy and push it under the new session's cookie, or join it into the new owner's copy
  // the moment that one is saved (QA 2026-10-06: a guest tab left open put its workout, routine
  // and default settings into the account after "Keep profile as is"). So any tab whose owner
  // changes under it drops what it holds, signed in or not, and takes the new owner's copy as it
  // is once that is saved (takeSaved); until then it writes nothing (refuseStale). Whoever signs in
  // there passes the same check. The owner key goes first on both a sign-in and a sign-out, so
  // this runs before the new owner's copy reaches this tab.
  window.addEventListener('storage', e => {
    if (e.key !== 'gym_owner') return
    // Each owner change another tab made ends the imports begun before it, judged by the event's
    // own before and after, not by the key now: a tab that slept through A signing out and back
    // in, or A → B → A, finds the key back at A when these events reach it, and an import begun
    // before the round trip must not go on as if nothing happened (NATG-535 SEC-02-R1). Store
    // subscribers hear of it, so an open import confirm closes (Settings doImport).
    const moved = e.oldValue !== e.newValue
    if (moved) ownerEpoch++
    const owner = readOwner()
    // The copy this tab holds needs handing over only when the owner now is not the one it holds.
    if (owner === seenOwner) { if (moved) set({}); return }
    handOver(owner)
  })
  // Everything the owner event does, also run by a save that finds the owner moved before that
  // event has (refuseStale). That ends the imports begun before it too (ownerEpoch), as the event
  // would once it ran.
  function handOver(owner) {
    clearTimeout(pushTm)
    pushTm = null
    replaceRev = null   // a replace armed for the previous owner is not the next one's (NATG-570)
    adoptWrite = null   // nor is an adoption's write
    // A guest's workout running here went along with the sign-in in the other tab (it joined this
    // browser's saved copy first, setUser), and this tab shows it again once that tab is done
    // (followSignIn). Said, so a workout that leaves the screen mid-set is not taken for lost; only
    // where the workout is on screen (a tab on Stats never showed it), and it goes on right here.
    if (!seenOwner && owner && get().S.active && /^#\/workout(?:[/?]|$)/.test(location.hash || '')) {
      import('./useUI.js')
        .then(({ useUI }) => useUI.getState().toast(t('Signed in from another tab. Your workout came along, keep going here.')))
        .catch(() => {})
    }
    const S = restartedState(get().S)
    meta.set(S, { base: null, owed: false })
    seenWid = readWid()
    seenOwner = owner
    ownerEpoch++   // also for an event that carries no before and after, and for a save that hands over
    handedOver = true
    const user = get().user
    set({ ...(user && user.id !== owner ? { user: null } : {}), S })
    takeSaved()
  }
  // Another tab of this browser synced — its marker moved to a revision this tab's copy does not
  // descend from. Rather than take that tab's saved copy (storage holds the copy and its marker
  // under two keys, and an event can arrive with one updated and not the other), this tab asks
  // the server, as it would on coming back to it: one small request, and a pull only if the
  // revision really moved. A hidden tab does the same when it is shown again. Its own base still
  // guards the push either way: a copy this tab has not refreshed gets a 409 and a merge.
  window.addEventListener('storage', e => {
    if (e.key !== SYNC_KEY || !e.newValue) return
    // A handover still provisional settles here when the sign-in's marker lands after its save.
    if (!get().user && !(handedOver ? takeSaved() : followSignIn())) return
    const user = get().user
    if (!user || localStorage.getItem('gym_owner') !== user.id) return
    let theirs = null
    try { theirs = JSON.parse(e.newValue) } catch { return }
    if (theirs?.rev == null || (theirs.rev === metaOf().base?.rev && theirs.wid === metaOf().base?.wid)) return
    checkRev(true)
  })

  // Another tab saved: its copy joins this one's at once, so this tab shows it and never writes
  // over it. When the saved copy holds everything this tab has, this tab takes it as it is, with
  // where it stands with the server (its marker and dirty flag); otherwise the join is saved and
  // pushed like any change.
  // A tab the owner changed under takes the new owner's saved copy as it is, with where it stands
  // with the server: it has no changes of its own to join, only the previous owner's copy, or a
  // guest's, which must not go into it.
  // The handover stays provisional until the sign-in has settled: this tab signed in as the new
  // owner (followSignIn), or nobody owns the copy (a sign-out). Until then it still writes nothing
  // (refuseStale) and takes each save of the owner's copy as it is. A copy taken while the sign-in
  // was still saving (its provisional copy, in step with no revision) and then joined into the
  // account's final save wrote that save over with this tab's fresh-profile settings, and dropped
  // the account's marker, so the other tab pushed without a base revision and this one stayed
  // signed out over the account's data (NATG-564).
  const takeSaved = () => {
    if (!handedOver) return false
    // Only a copy known to be written under the new owner: one saved before the owner was
    // recorded beside it is most likely the guest's copy the sign-in is still asking about.
    if (readOwner() !== seenOwner || readWidOwner() !== (seenOwner || '')) return false
    const theirs = readSaved()
    if (!theirs) return false
    const S = sanitizeAccent(theirs)
    seenWid = readWid()
    meta.set(S, { base: readStoredSync(), owed: storedOwed() })
    registerCustom(S.customEx)
    registerExerciseAliases(S.exAliases)
    set({ S })
    handedOver = false
    // Already signed in as the new owner, this tab has nothing left to follow.
    if (seenOwner && get().user?.id !== seenOwner && !followSignIn()) handedOver = true
    return true
  }
  // A tab signed out, or a guest's, whose browser another tab signed in: once that sign-in is
  // settled (its question answered, its copy saved under the account and in step with a revision),
  // this tab is signed in too, as a tab opened now would be. The session cookie is the browser's.
  // A guest's workout carried into the account shows here again. A tab the owner changed under
  // gets here through takeSaved, which keeps its handover provisional until this succeeds.
  const followSignIn = () => {
    if (get()?.user || handedOver) return false
    const owner = readOwner()
    if (!owner || owner !== seenOwner || readWidOwner() !== owner || readWid() !== seenWid) return false
    let u = null
    try { u = JSON.parse(localStorage.getItem('gym_user')) } catch { return false }
    if (!u || u.id !== owner) return false
    const m = readAdopt()
    if (m && m.uid === owner) return false
    const base = readStoredSync()
    if (!base) return false
    meta.set(get().S, { base, owed: storedOwed() })
    set({ user: u })
    setSync({ held: false })
    return true
  }
  // The answered sign-in's copy saved under its account once, whatever the answer did: an answer
  // that changed nothing here ("Add them" with nothing to add, a profile with no copy yet) wrote
  // no save, and another tab waited on one (takeSaved).
  const claimSaved = () => {
    const u = get().user
    if (u && readOwner() === u.id && readWidOwner() !== u.id) persist(get().S, false, false)
  }
  const syncFromSaved = () => {
    if (handedOver) { takeSaved(); return }
    const wid = readWid()
    if (wid === seenWid || !savedIsMine()) return
    const theirs = readSaved()
    if (!theirs) return
    const mine = get().S
    const merged = joinTabs(mine, theirs, false)
    seenWid = wid
    if (sameCopy(merged, mine)) return
    if (sameCopy(merged, theirs)) {
      merged._ts = Math.max(Number(theirs._ts) || 0, Number(mine._ts) || 0)
      meta.set(merged, { base: readStoredSync(), owed: storedOwed() })
      registerCustom(merged.customEx)
      registerExerciseAliases(merged.exAliases)
      set({ S: merged })
      return
    }
    persist(merged, true)
  }
  window.addEventListener('storage', e => {
    if (e.key !== WID_KEY || !e.newValue || e.newValue === seenWid) return
    syncFromSaved()
  })

  // Before a sign-out decides anything: the pull on its way has landed, and the push in flight,
  // with any queued behind it, has landed too. Only then is the copy asked whether it still owes
  // the server something, so a push that is already carrying it is not sent a second time
  // (NATG-643). A change made after that push left, or a push that failed, is still owed and is
  // pushed once more. Then the photos and videos still waiting get one more try
  // (lib/media-owed.js, at most a minute): they are owed exactly like a change is. A copy that
  // owes nothing is not pushed: the server would take it as a new revision, and every other
  // device of the account would pull it once for nothing (NATG-573).
  const settle = async () => {
    syncFromSaved()   // what another tab of this browser saved and has not sent counts too
    if (pulling) await pulling.promise
    while (pushing) await pushing
    if (owes()) await get().pushState()   // never throws — an owed copy stays owed when it does not land
    while (pushing) await pushing
    await settleMedia(get().S)
  }
  // Whether a sign-out asked for under `owner` (the browser's owner at the click) was overtaken by
  // another tab signing a different account in while it waited. Its logout would end that
  // account's session in this browser, and "everywhere" its sessions on every device, so it stops
  // and changes nothing (NATG-581). An owner gone to nobody is not another account: another tab
  // signed the same account out, and the sign-out goes on as before. This tab hands over to the
  // new owner first, as a save does (refuseStale): the handover closes the sheets and the toast
  // (useUI), so whatever the caller then says about the cancelled sign-out stays on screen.
  const overtaken = owner => {
    const now = readOwner()
    if (!now || now === owner) return false
    if (now !== seenOwner) handOver(now)
    return true
  }

  // Forget where this device stood with the server — a different account, a sign-out. The copy
  // that replaces it descends from no revision and owes nothing.
  const forgetSync = () => {
    meta.set(get().S, { base: null, owed: false })
    offlineChanges = false   // a push the previous account owed is not this one's to announce
    try { for (const k of [SYNC_KEY, DIRTY_KEY, SYNCED_AT_KEY, SYNCED_FP_KEY]) localStorage.removeItem(k) } catch { /* nothing to keep */ }
    fpOf = null
  }

  // Everything a sign-out leaves behind on this device, whichever way it was triggered. The owner
  // goes before the wiped copy is written: another tab must learn that the copy is nobody's before
  // it sees the new copy, or it joins its own copy of the account into it (QA 2026-10-06).
  const clearLocalSession = () => {
    const hadMedia = referencedHashes(get().S).size > 0
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    forgetSync()
    releaseAdopt()   // the copy it was about is gone
    localStorage.removeItem(KEY)
    bumpOwnerGen()
    localStorage.removeItem('gym_owner_name')
    localStorage.removeItem('gym_owner')
    // The account's share lists go with it: a shared device keeps nothing of whom it shared with.
    try { localStorage.removeItem(SHARED_KEY) } catch { /* nothing to keep */ }
    sharesFresh = null
    sharesBefore = null
    set({ shares: null, sharesError: false })
    seenOwner = null   // a guest's tab now: it joins what other signed-out tabs save (as setUser)
    ownerEpoch++       // also when the session had already expired: the owner key goes now
    handedOver = false
    // Signed out, this device is nobody's: the sign-in screen is in the instance's language.
    persist(freshState(), false)
    setSync({ offline: false, auth: false, lastError: null, pending: false, lastSynced: 0 })
    // On a phone the file is wiped with it, now rather than after the usual wait: a start in
    // between would open in local mode on the signed-out account's data, since that boot takes
    // the file whenever storage holds nothing.
    // The share lists' file goes too, after the state file and as part of the same wait: the
    // state file is the write a sign-out must not race.
    const wiped = MOBILE ? Promise.resolve(nativePersist(true)).then(() => writeJsonFile(SHARED_FILE, null)) : null
    // The account's photos and videos go with its copy (a shared device keeps nothing of it),
    // except the ones a stash still refers to — whatever was pending is in a stash by now
    // (signOut refuses otherwise) and comes back with it. A file picked from here on is kept.
    // After the state file, which is the one write a sign-out must not be kept waiting for. Also
    // when the copy refers to no media any more: a photo removed in the last hour, or one whose
    // exercise was deleted, is still in the store until the local clean-up's grace has passed,
    // and on a shared device it must not outlast the sign-out. The app's sync opens the store at
    // start (lib/media-sync.js), so there this always runs; only a store nothing has opened is
    // left alone, since nothing can have been put into it.
    if (hadMedia || mediaStoreInUse()) {
      const since = Date.now()
      Promise.resolve(wiped).then(() => readStashes())
        .then(all => mediaStore.retainOnly(new Set(Object.values(all).flatMap(e => [...referencedHashes(e?.state)])), { keepPutAfter: since }))
        .catch(() => {})
    }
    return wiped
  }

  /* The changes a forced sign-out or disconnect keeps, so that no change is ever lost silently.
     Keyed by server and account — '' for the server of a phone whose pairing was lost with its
     address — in localStorage and, on a phone, in a file beside the state mirror, since the
     sign-out wipes the rest. */
  const stashKey = (server, uid) => (server || '') + '|' + uid
  const readStashes = async () => {
    let all = {}
    try { all = JSON.parse(localStorage.getItem(STASH_KEY)) || {} } catch { /* none */ }
    if (MOBILE) { const f = await readJsonFile(STASH_FILE); if (f && typeof f === 'object') all = { ...all, ...f } }
    return all
  }
  // True when at least one durable copy of the stashes was written.
  const writeStashes = async all => {
    const empty = !Object.keys(all).length
    let ok = false
    try { if (empty) localStorage.removeItem(STASH_KEY); else localStorage.setItem(STASH_KEY, JSON.stringify(all)); ok = true } catch { /* full */ }
    if (MOBILE) {
      await writeJsonFile(STASH_FILE, all)
      const back = await readJsonFile(STASH_FILE)
      ok = ok || (!!back && Object.keys(back).length === Object.keys(all).length)
    }
    set({ keptRev: get().keptRev + 1 })
    return ok || empty
  }
  // A different account signing in on a copy whose session ended without a sign-out (it expired,
  // was revoked, the server no longer knows the account) — or on a live one that still owes it or
  // runs a workout: the copy goes, as it always has — it
  // must not be pushed into the new account — but it is kept aside first, the way a forced
  // sign-out keeps what it owed, for when that account comes back. Not only what it owed: a copy
  // in step with a server that has since lost the account (rebuilt, the account deleted, the data
  // directory gone) is the last one there is, and a workout running here never reached any server.
  // A proper sign-out clears the owner first, so a shared device keeps nothing after one. Written
  // to localStorage right here, since setUser wipes the copy straight after; on a phone the file
  // follows, and pairing waits for it (`keeping`) before it goes on. Kept changes can be saved as a
  // backup file from Settings (keptState), to import into another profile.
  const keepForPrevious = uid => {
    syncFromSaved()
    const S = get().S
    if (!hasData(S) && !S.active && !pendingRefCount(S)) return
    // Still signed in (an account switch on a live session): its server has the copy, so only
    // what it owes and a running workout are kept, as before.
    const live = get().user?.id === uid
    if (live && !(owesOwn() && hasData(S)) && !pendingRefCount(S) && !S.active) return
    const server = serverBase()
    const key = stashKey(server, uid)
    let all = {}
    try { all = JSON.parse(localStorage.getItem(STASH_KEY)) || {} } catch { /* none */ }
    const prev = all[key]?.state
    const state = prev ? mergeStates(S, prev) : clone(S)
    state.active = carryActive(S, state) || carryActive(prev, state) || null
    // The name comes from beside the owner when the account is no longer signed in here (its
    // session ended), so the screens say whose changes these are rather than an id.
    let name = get().user?.id === uid ? get().user.name || '' : ''
    if (!name) { try { name = localStorage.getItem('gym_owner_name') || '' } catch { /* the id then */ } }
    const entry = { server: server || null, uid, name, at: Date.now(), state }
    all[key] = entry
    // A second full copy beside the first may not fit (a profile near the size limit): the copy
    // in storage is wiped next anyway, so it makes the room.
    const v = JSON.stringify(all)
    try { localStorage.setItem(STASH_KEY, v) }
    catch {
      try { localStorage.removeItem(KEY); localStorage.setItem(STASH_KEY, v) } catch { /* still full — the file may still take it */ }
    }
    set({ keptRev: get().keptRev + 1 })
    if (MOBILE) keeping = readStashes().then(f => writeStashes({ ...f, [key]: entry })).catch(() => {})
  }
  // What a sign-out or disconnect answers when something is owed: how many changes, and how many
  // photos or videos, when there are any.
  const owedResult = (left, extra = {}) => ({ owed: true, count: left.count, ...(left.media ? { media: left.media } : {}), ...extra })
  const stashOwed = async () => {
    const user = get().user
    if (!user) return true
    const all = await readStashes()
    const server = serverBase()
    const key = stashKey(server, user.id)
    const prev = all[key]?.state
    const state = prev ? mergeStates(get().S, prev) : clone(get().S)
    // Each running workout in the kept copy's unit (carryActive), never a kg session under lb.
    state.active = carryActive(get().S, state) || carryActive(prev, state) || null
    // Kept while a sign-in's question was open: a copy that was never this account's, added back
    // like an answered "Add them" (applyStash), the account's settings and history first.
    const adopt = adoptHold || !!all[key]?.adopt
    all[key] = { server: server || null, uid: user.id, name: user.name || '', at: Date.now(), state, ...(adopt ? { adopt: true } : {}) }
    return writeStashes(all)
  }
  // A workout running here is never on the server (a push leaves `active` out), so a sign-out
  // with nothing owed used to wipe it. It is kept aside the way owed changes are, on its own:
  // the rest of the copy is the server's already, and a shared device keeps no more of the
  // account than it has to. It comes back on the next sign-in here as this account (applyStash).
  const stashActive = async () => {
    const user = get().user
    const a = get().S.active
    if (!user || !a) return true
    const all = await readStashes()
    const server = serverBase()
    const key = stashKey(server, user.id)
    const prev = all[key]?.state
    const state = prev ? clone(prev) : Object.assign(clone(DEF), { _ts: 0, unit: get().S.unit || 'kg' })
    state.active = clone(carryActive(get().S, state))
    all[key] = { server: server || null, uid: user.id, name: user.name || '', at: Date.now(), state }
    return writeStashes(all)
  }
  // A sign-out ends the rest and the hold running on this device: the countdown must not go on
  // over the sign-in screen, or ring for an account that has left. Before the logout request,
  // while the session can still call the server push off. A hold hands back what it held first.
  const stopTimers = async () => {
    try {
      const ui = (await import('./useUI.js')).useUI.getState()
      ui.abandonWork?.()
      ui.stopRest?.()
    } catch { /* no timers to stop */ }
  }

  // Back on the server and account a forced sign-out or disconnect left: the kept changes are
  // merged in like a conflict (lib/sync-merge.js), marked owed and pushed, and the stash goes.
  // If the push does not land, the copy itself owes them from here and nothing wipes it.
  const applyStash = async () => {
    const user = get().user
    if (!user) return
    const all = await readStashes()
    if (!answerIsFor(user.id)) return   // the account left meanwhile: its stash stays for it
    const exact = stashKey(serverBase(), user.id)
    const keys = Object.keys(all).filter(k => k === exact || (all[k]?.uid === user.id && !all[k]?.server))
    if (!keys.length) return
    const S = get().S
    let merged = S
    for (const k of keys) merged = all[k].adopt ? mergeStates(merged, all[k].state, { prefer: 'a' }) : mergeStates(merged, all[k].state)
    merged = Object.assign(clone(DEF), merged)
    // A kept running workout comes back in the unit of the copy it joins: the account may have
    // switched to lb (converting every weight) since it was kept in kg.
    merged.active = S.active || keys.map(k => carryActive(all[k].state, merged)).find(Boolean) || null
    persist(merged, false)
    markOwed(true)
    if (MOBILE) await nativePersist(true)   // the durable copy holds it before the stash goes
    await get().pushState()
    if (!answerIsFor(user.id)) return   // nor is it dropped for a push that did not go
    for (const k of keys) delete all[k]
    await writeStashes(all)
  }

  // "Keep profile as is": what this device held before the sign-in leaves the screen, but not the
  // device. It is kept aside like a kept change (its own key, never added back on its own) and can
  // be saved as a backup file from Settings, in case the answer was the wrong one.
  const keepAside = async (S, name, keepUid) => {
    if (!hasData(S)) return
    const state = clone(S)
    const all = await readStashes()
    const uid = keepUid || 'device-' + Date.now().toString(36)
    all[stashKey(serverBase(), uid)] = { server: serverBase() || null, uid, name, at: Date.now(), state }
    await writeStashes(all)
    set({ keptRev: get().keptRev + 1 })
  }
  const keepDeviceCopy = () => keepAside(get().S, t('This device, before signing in'))

  // adoptProfile's work (see there). Every way out answers the question — releaseAdopt — before
  // the decision is written and pushed; only a server that could not be reached leaves it owed.
  const runAdopt = async (ask, { alwaysAsk = false } = {}) => {
    // The account signing in. Another tab can sign out, or in as someone else, while this runs (the
    // question can stay open for minutes): from then on nothing here asks the server, writes, pushes
    // or answers the question, which is no longer this tab's to settle. Only this tab's hold goes.
    const uid = get().user?.id
    const left = () => { if (answerIsFor(uid)) return false; setHold(false); return true }
    const gone = { adopted: false, added: false, gone: true }
    if (pulling) await pulling.promise
    if (left()) return gone
    // An adoption resumed after a restart is the sign-in's own: whether this copy already belonged
    // to the account was decided then — boot's sign-in sees the owner that sign-in wrote.
    const owedMark = adoptOwed()
    const sameAccount = owedMark ? !!owedMark.rejoined : rejoined
    if (owedMark?.alwaysAsk) alwaysAsk = true
    let res
    try { res = await api('/api/data') }
    catch (e) {
      if (left()) return gone
      failed(e)
      // Nothing decided: with a sign-in that marked it, sync stays held and the next check asks
      // again (checkRev); a bare call has nothing to hold for.
      if (!owedMark) releaseAdopt()
      throw e   // the caller's toast: sign-in needed the server anyway
    }
    if (left()) return gone
    // As pullState: a copy whose base is another account's is settled no way at all. Every branch
    // below would restamp or drop that base and push the copy as this account's. The hold stays,
    // so nothing syncs until a sign-out, a switch or a reload.
    const held = metaOf().base
    if (held && held.uid !== uid) { refuse('adopt', held.uid, uid); return { adopted: false, added: false, refused: true } }
    let { state, rev } = res
    reached()
    // This read decides again; a write armed by an earlier run of this adoption is re-armed below
    // only if it is still the one to send.
    adoptWrite = null
    let asked = false
    const askAbout = async extras => {
      if (!(extras.workouts || extras.bodyweight || extras.customEx || extras.routines || extras.setup) || typeof ask !== 'function') return false
      asked = true
      return !!(await ask(extras))
    }
    // The question can stay open for minutes: what is applied is the server's copy once it
    // closes. Unreachable by then, the copy read before it stands — its revision is older than
    // the server's, so the next pull still brings in what changed.
    const reread = async () => {
      if (!asked) return
      try { const r = await api('/api/data'); if (r && r.state) ({ state, rev } = r) } catch { /* the first read */ }
    }
    // A reset or import made while the hold kept its push back armed a replace of the copy this
    // throws away: left armed, the next ordinary edit went out as that replace, over what another
    // device had written since the server's copy was taken (NATG-596).
    const takeServer = () => {
      replaceRev = null
      const copy = sanitizeAccent(Object.assign(clone(DEF), state))
      copy.active = carryActive(get().S, copy)
      if (rev != null) adopt(copy, rev)
      else { dropSync(); persist(copy, false, false); markOwed(false) }
      confirmed(get().S)
    }
    const S0 = get().S
    if (!state) {
      const push = hasData(S0) && (!alwaysAsk || sameAccount || await askAbout(localExtras(S0, null)))
      if (left()) return gone
      // The write over the empty profile, unless the question was just asked and answered, keeps
      // the sign-in's mark until it lands or its 409 is handed back (adoptWrite); only the hold is
      // lifted, for that write to go. A bare call that marked nothing marks it now, so a write that
      // fails on the way is resumed like a sign-in's.
      const guarded = push && rev != null && !asked
      if (!guarded) releaseAdopt()
      else {
        if (!adoptOwed()) writeAdopt({ uid, rejoined: sameAccount, alwaysAsk, pre: owedMark?.pre || preOf(S0) })
        setHold(false)
      }
      if (hasData(get().S) && !push) {
        if (asked) await keepDeviceCopy()
        if (left()) return gone
        takeServer()
        await applyStash()
        return { adopted: true, added: false }
      }
      markOwed(false)
      if (!push) {
        if (rev != null) writeSync(rev, 0)
        confirmed(get().S)
        await applyStash()
        return { adopted: false, added: false }
      }
      // Pushed against the revision the read returned (0: no profile), never without a base
      // (NATG-533). A profile that appeared since answers 409, and unless this copy's question was
      // just asked and answered, that 409 is not merged (doPush): the profile is asked about once,
      // as one found by the read would have been (below). A 409 after an answer is two devices'
      // conflict, merged as ever.
      if (rev != null) writeSync(rev, 0)
      if (guarded) adoptWrite = { uid }
      adoptRaced = null
      await get().pushState()
      const raced = adoptRaced?.uid === uid ? adoptRaced : null
      adoptRaced = null
      if (left()) return gone
      // Not landed and not raced (no network, a server error): held, still owed, and the next
      // check resumes it. What a sign-out kept for this account waits for that run too.
      if (!raced && guarded && adoptWrite?.uid === uid) return { adopted: false, added: false }
      if (!raced) {
        await applyStash()
        return { adopted: false, added: false }
      }
      ;({ state, rev } = raced)
    }
    if (sameAccount) {
      // This copy already belongs to the account: a phone paired again after its token was
      // refused, a browser signed in again after its session ended. It may hold days the server
      // never saw — new workouts, but also edits to routines and settings, which the question
      // below never covered. Merged like a conflict between two devices (the union of entries,
      // the later edit of each routine, the newer copy's settings) and pushed against the
      // server's revision. Only a copy with nothing of its own since its base takes the
      // server's as it is, so an entry deleted elsewhere meanwhile stays deleted.
      releaseAdopt()
      const S = get().S
      const { base, owed } = metaOf()
      if (!hasData(S) || (!owed && base && !localChanged(S))) {
        takeServer()
        await applyStash()
        return { adopted: true, added: false, merged: false }
      }
      // A copy with no base yet merges against the revision just read, as mergeInto would record
      // it anyway; one that has a base keeps it, and mergeInto holds it to this account.
      if (!base) writeSync(rev, 0, state?._wid)
      if (!mergeInto(S, state, rev)) return { adopted: false, added: false, refused: true }
      await get().pushState()
      await applyStash()
      return { adopted: true, added: false, merged: true }
    }
    // The question is about what this copy held when the sign-in began (the marker's `pre`). What
    // was logged since — while an adoption that could not reach the server kept sync held — is
    // this account's own already: never offered as "logged while signed out", never dropped by
    // "Keep profile as is", but merged like any change of the account's.
    const pre = owedMark?.pre
    const keep = await askAbout(localExtras(pre ? splitByPre(S0, pre).before : S0, state))
    if (left()) return gone
    await reread()
    if (left()) return gone
    releaseAdopt()
    if (keep) {
      const S = get().S
      const merged = Object.assign(clone(DEF), mergeStates(state, S, { prefer: 'a' }))
      merged.active = carryActive(S, merged)
      // The account's plan wins; a day it has nothing planned for takes the device's.
      for (const f of ['week', 'dayPlan']) {
        const mine = S[f] && typeof S[f] === 'object' ? S[f] : {}
        merged[f] = { ...mine, ...(merged[f] || {}) }
      }
      persist(merged, false)
      if (rev != null) writeSync(rev, 0, state?._wid)
      else dropSync()
      await get().pushState()
      await applyStash()
      return { adopted: true, added: true }
    }
    const later = pre ? splitByPre(get().S, pre).later : null
    if (asked) await keepDeviceCopy()
    if (left()) return gone
    takeServer()
    if (later) {
      const S = get().S
      const merged = Object.assign(clone(DEF), mergeStates(S, later, { prefer: 'a' }))
      merged.active = S.active || null
      persist(merged, false)
      if (rev != null) writeSync(rev, 0, state?._wid)
      else dropSync()
      await get().pushState()
    }
    await applyStash()
    return { adopted: true, added: false }
  }
  // A copy's workouts, weigh-ins and custom exercises split by the names a sign-in recorded when it
  // began (`pre`, see setUser): `before` holds what was there then, `later` — null when nothing
  // is — what was logged since, with the custom exercises its workouts use, in this copy's unit.
  const ADOPT_FIELDS = ['workouts', 'bodyweight', 'customEx']
  const splitByPre = (S, pre) => {
    const before = { ...S }
    const later = { _ts: S._ts, unit: S.unit, ...(S.unitSet ? { unitSet: S.unitSet } : {}) }
    let any = false
    for (const f of ADOPT_FIELDS) {
      const had = new Set(Array.isArray(pre?.[f]) ? pre[f] : [])
      const xs = Array.isArray(S[f]) ? S[f].filter(x => x != null) : []
      before[f] = xs.filter(x => had.has(entryKey(f, x)))
      later[f] = xs.filter(x => !had.has(entryKey(f, x)))
      if (later[f].length) any = true
    }
    if (!any) return { before, later: null }
    const used = new Set(later.workouts.flatMap(w => (Array.isArray(w?.entries) ? w.entries : []).map(e => e?.id)))
    later.customEx = [...later.customEx, ...before.customEx.filter(c => used.has(c.id))]
    return { before, later }
  }
  const preOf = S => {
    const ids = resetIdsOf(S)
    return Object.fromEntries(ADOPT_FIELDS.map(f => [f, ids[f] || []]))
  }

  // The file mirror is the durable copy: WebView storage can be evicted while the files
  // directory survives. A mirror newer than what localStorage holds is a change this phone made
  // and may not have sent — it is taken, and owed. Only the paired account's own, though, and
  // only the copy the owner file says was written (saveMirror): one another account left there,
  // or one the file never finished replacing, is not this account's latest — taken, it used to
  // be pushed into whichever account was paired now. And it goes without the revision storage
  // quotes, so the pull merges it with the server's copy (its first-sync path): the file can
  // still hold a copy the server has since moved past, and a merge brings back at most what was
  // deleted meanwhile, where a push with a matching baseRev dropped the other side's work.
  const restoreFromMirror = async remote => {
    const saved = await nativeLoad()
    if (!saved || (saved._ts || 0) <= (get().S._ts || 0)) return
    const of = await readJsonFile(MIRROR_OWNER_FILE)
    const who = remote?.user?.id || null
    let owner = null
    try { owner = localStorage.getItem('gym_owner') } catch { /* evicted along with the copy */ }
    if (!who || of?.owner !== who || (owner && owner !== who) || of.ts !== (saved._ts || 0)) return
    try { if (!owner) { bumpOwnerGen(); localStorage.setItem('gym_owner', who) } } catch { /* setUser writes it again */ }
    seenOwner = readOwner()
    persist(sanitizeAccent(Object.assign(clone(DEF), saved)), false, false)
    dropSync()
    markOwed(true)
  }

  const S0 = loadState()
  S0.customEx = healCustomEx(S0.customEx)
  registerCustom(S0.customEx)
  registerExerciseAliases(S0.exAliases)
  // Which photos and videos are still waiting for the server, known before the first sign-out
  // check has to ask (lib/media-owed.js). A copy without any leaves the media store unopened.
  if (referencedHashes(S0).size) loadPending()
  meta.set(S0, { base: readStoredSync(), owed: storedOwed() })
  const user0 = (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })()
  adoptHold = !!user0 && readAdopt()?.uid === user0.id
  const sync0 = { offline: false, pending: storedOwed(), auth: false, lastError: null, lastSynced: (() => { try { return +localStorage.getItem(SYNCED_AT_KEY) || 0 } catch { return 0 } })(), server: serverBase(), held: adoptHold }
  sync0.status = statusOf(sync0, user0)

  return {
    S: S0,
    user: user0,
    ready: false,
    // The connection as the screens show it — see statusOf above for every field.
    sync: sync0,
    /* Instance capabilities from GET /api/config. `config.coach` is present only when the owner
       has both enabled the Coach and connected a provider — every Coach entry point in the app
       hangs off it via coachAvailable(), so an unconfigured instance renders exactly what it
       always did, and a configured one is the only place any of it appears. */
    config: null,
    needsMobileOnboarding: false,   // mobile build only — set true by boot() on a genuine first launch
    // Mobile build only: the first-start permission steps (views/PermissionSteps.jsx) are due.
    // Set when that first launch's choice is made; never persisted, the steps keep their own
    // once-per-device record (lib/onboarding-perms.js).
    permSteps: false,
    finishPermSteps() { set({ permSteps: false }) },
    // A one-time device-link code this page was opened with (?link=, #95), until it is redeemed.
    // Never persisted: the code is good for minutes and belongs to this one visit.
    linkCode: null,
    // Mobile build only: how the Coach runs on this phone — { mode: 'off'|'server'|'byok',
    // provider, model, baseUrl } from lib/coach-device.js. Never the key, never a proposal.
    coachLocal: null,
    async setCoachLocal(patch) {
      set({ coachLocal: coachDeviceSettings(await saveCoachDevice(patch)) })
    },

    // Mutate a draft of S via producer fn, then persist + schedule sync. Every routine the change
    // touched carries the time of it, for a conflict to keep the version edited last.
    // The copy as it is now, on disk: the file mirror on a phone (written at once, not after the
    // usual wait), localStorage everywhere (persist writes it on every change). What hands a change
    // over from somewhere that keeps its own copy until told (the watch's and the Live Activity's
    // queues) waits for this before it lets go of it.
    saveNow() {
      return MOBILE ? nativePersist(true) : Promise.resolve()
    },
    update(mut, push = true) {
      const prev = get().S
      // Under test, every change proves it left the previous state as it was: the draft shares
      // whatever the producer did not touch, so a write into one of those would change history.
      const prevJson = import.meta.env?.MODE === 'test' ? JSON.stringify(prev) : null
      const draft = draftOf(prev)
      mut(draft.S)
      const S = draft.done()
      // The stamps below write the change's records into these two maps in place (stampDeletions,
      // stampEdits); a draft that never touched them still shares them with the previous state.
      for (const k of ['deleted', 'edited']) if (S[k] && typeof S[k] === 'object' && S[k] === prev[k]) S[k] = clone(S[k])
      // What the change removed, and which routines, workouts, settings and plan days it touched,
      // each with one time that comes after every stamp the copy already carries: a conflict then
      // keeps a removal and the edit made last, even from a device whose clock runs behind
      // (lib/sync-merge.js stampChange).
      S._ts = stampChange(prev, S, Date.now())
      if (prevJson !== null && JSON.stringify(prev) !== prevJson) throw new Error('update(): the previous state was changed in place')
      persist(S, push)
      // A photo or video added to a workout is a change worth the day's backup too: the one
      // finishing wrote went before the finish screen's pictures (autoBackupNow). Not a removal,
      // nor a workout deleted: the day's copy then still holds what was taken off, as a backup should.
      if (MOBILE && S.autoBackup && gainedWorkoutMedia(prev, S)) {
        clearTimeout(backupTm)
        backupTm = setTimeout(() => { backupTm = null; get().autoBackupNow() }, AUTO_BACKUP_SOON_MS)
      }
    },
    // An edit of a saved workout (lib/session-edit.js) is saved or dropped like any other change:
    // the store's own sync takes it to the server, and a conflict on the way is settled by
    // mergeStates like one between two devices. A save that cannot happen throws before anything
    // is written, and the editor stays open with the edits.
    saveHistoryEdit() {
      let saved = null
      get().update(S => { saved = saveWorkoutEdit(S) })
      return saved
    },
    discardHistoryEdit() { get().update(S => { S.active = null }) },
    // An edit that took out every set deletes the workout rather than saving it empty.
    deleteHistoryEdit() {
      let removed = false
      get().update(S => { removed = deleteEditedWorkout(S) })
      return removed
    },
    // Settings → unit. `convert` walks every stored weight into the new unit (lib/units.js); off,
    // only the label changes. Either way the choice is stamped (`unitSet`), so a merge with a
    // copy still in the old unit brings that copy over rather than mixing the two (lib/sync-merge.js),
    // and a conversion goes to the server at once, as an ordinary conditional push: another device
    // still logging in the old unit meets it on its very next push, and a copy it pushed first is
    // converted before it is merged in.
    setUnit(to, { convert = true } = {}) {
      const S0 = get().S
      if ((S0.unit || 'kg') === to) return null
      const S = clone(convert ? convertStateUnit(S0, to) : { ...S0, unit: to })
      S.unitSet = { at: Math.max(Date.now(), highestStamp(S0) + 1), convert }
      persist(S, true)
      return convert && get().ready ? get().pushState() : null
    },
    // Settings → Reset everything: a new profile (restartedState), stamped with when (`resetAt`).
    // Pushed as a replace, and the stamp is what makes it hold: a device that has not seen the
    // reset and still pushes a change of its own gets the 409, and its merge keeps only what that
    // device made after the reset instead of bringing the whole profile back (lib/sync-merge.js).
    //
    // With it goes `resetIds`, the names of every entry the reset wiped: this copy's, the earlier
    // resets' (a copy older than those too is still judged right), and the server's — it may hold
    // entries this device never pulled. A device that has not seen the reset loses exactly those,
    // and keeps whatever else it holds, whatever its dates say.
    //
    // Signed in, the push reads the account's profile before it goes (readForReplace): the
    // server's names are taken from that read, before the PUT, and the PUT goes against its
    // revision, never without one (NATG-655). Another device that writes between the two gets the
    // reset's 409 merge: what it added since the read stays, what it edited of the entries named
    // here is still wiped, and the reset's settings, plan and unit win (sinceReset).
    resetEverything() {
      const cur = get().S
      const S = restartedState(cur)
      S.resetAt = Math.max(Date.now(), highestStamp(cur) + 1)
      S.resetIds = mergeResetIds(cur.resetIds, resetIdsOf(cur))
      const prepare = read => {
        const now = get().S
        if (!read || now.resetAt !== S.resetAt) return
        const ids = mergeResetIds(now.resetIds, mergeResetIds(read.resetIds, resetIdsOf(read)))
        if (JSON.stringify(ids) !== JSON.stringify(now.resetIds)) persist(Object.assign(clone(now), { resetIds: ids }), false)
      }
      get().replaceState(S, !!get().user, { kind: 'reset', prepare })
    },
    // Before a backup replaces this copy (Settings → Import): the workouts the server holds that the
    // backup does not — logged since it was made, or on another device meanwhile. The import is a
    // deliberate replace and deletes them from the profile; the confirm says so and offers to merge
    // them in instead (importBackup). null when there are none, when nobody is signed in, or when
    // the server cannot be asked — the replace then goes as it always has.
    async importConflict(backup, token = get().importToken()) {
      // A check for an import that is no longer this account's asks nothing, not even the server:
      // its request would go out under whichever session the browser holds now (SEC-02). The
      // answer says so, tied to that import, rather than null, which means nothing to warn about.
      const stale = Object.freeze({ stale: true, token })
      if (!get().importIsCurrent(token)) return stale
      // No account (a phone in local mode, a guest): this copy is the only one there is, so the
      // workouts it holds that the backup lacks are asked about the same way, never just replaced.
      if (!token.uid) {
        const key = w => entryKey('workouts', w)
        const inBackup = new Set((Array.isArray(backup?.workouts) ? backup.workouts : []).filter(Boolean).map(key))
        const here = (get().S.workouts || []).filter(w => w && !inBackup.has(key(w))).length
        return here ? { workouts: here, state: get().S, rev: null, device: true, token } : null
      }
      let res
      try { res = await api('/api/data') } catch { return null }
      if (!get().importIsCurrent(token)) return stale   // the account the confirm would be about has gone
      const state = res?.state
      importRead = { token, state: state || null, rev: res?.rev ?? null }
      if (!state) return null
      const key = w => entryKey('workouts', w)
      const inBackup = new Set((Array.isArray(backup?.workouts) ? backup.workouts : []).filter(Boolean).map(key))
      const server = (Array.isArray(state.workouts) ? state.workouts : []).filter(Boolean)
      const onServer = new Set(server.map(key))
      const workouts = server.filter(w => !inBackup.has(key(w))).length
      // This device's own workouts the server has not received yet go the same way, and count too.
      const mine = owes() ? (get().S.workouts || []).filter(w => w && !inBackup.has(key(w)) && !onServer.has(key(w))).length : 0
      return workouts + mine ? { workouts: workouts + mine, state, rev: res.rev, local: mine > 0 || owes(), token } : null
    },
    // Who this tab is acting for right now: the account signed in here (or nobody, a guest), the
    // browser's owner key and the owner counter. A job that outlives an await takes one when it
    // starts and asks ownerHolds before it acts for that owner again: media sync's runs, downloads
    // and clean-up (lib/media-sync.js), and each import.
    ownerToken() {
      return Object.freeze({ uid: get().user?.id || null, owner: readOwner(), epoch: ownerEpoch })
    },
    // Whether the owner `token` was taken for is still this tab's (see ownerHolds above).
    ownerHolds(token) { return !!token && ownerHolds(token) },
    // Whose import this is, taken when the file is chosen, before anything is awaited: Settings
    // hands it to every step after (importConflict, importIsCurrent, importBackup), and each judges
    // that token alone, never what another import last read (NATG-535 SEC-01).
    importToken() { return get().ownerToken() },
    // Whether the import `token` belongs to is still this account's (ownerHolds). Settings closes
    // the confirm once it is not, and importBackup refuses it. Stale is for good: an account that
    // comes back finds the import gone, as the confirm already is.
    importIsCurrent(token) {
      if (!token || staleImports.has(token)) return false
      if (ownerHolds(token)) return true
      staleImports.add(token)
      return false
    },
    // A backup in place of this copy. With `mergeWith` — importConflict's answer — the server's copy
    // is merged in instead of replaced, together with this device's copy as it is when the user
    // answers: the backup's settings and plan, every entry of all of them (mergeStates with the backup
    // preferred, in the backup's unit), pushed against that revision like any other change, so a
    // workout logged meanwhile elsewhere, or here, is not lost either.
    //
    // Either way the backup is a deliberate add-back (lib/sync-merge.js stampRestore): what it holds
    // stays, though this device or the server recorded it as deleted since, and its settings and
    // plan are the latest choice, on every device. The replace goes against the revision the check
    // read (or this copy's own): a change another device synced meanwhile is merged in, not wiped.
    //
    // An import whose token (importToken) no longer holds is refused whole, whichever button was
    // pressed: merged or replaced, it would write one account's choice into another's copy
    // (NATG-535). So is an answer from another import's check, and an import with no token at all:
    // nothing would hold it to the account it began under. `mergeWith` carries its check's token.
    // Returns whether the import went.
    importBackup(backup, { mergeWith, token } = {}) {
      const own = token || mergeWith?.token || null
      if (!own || mergeWith?.stale || (mergeWith?.token && mergeWith.token !== own) || !get().importIsCurrent(own)) return false
      const cur = get().S
      const uid = get().user?.id
      // The replace goes against the revision this import's own check read: the same token.
      const ours = !!importRead && importRead.token === own
      const read = mergeWith?.state ? mergeWith : ours ? importRead : null
      if (ours) importRead = null
      const server = read?.state || null
      const now = Math.max(Date.now(), highestStamp(cur) + 1, highestStamp(server) + 1, highestStamp(backup) + 1)
      const next = sanitizeAccent(Object.assign(clone(DEF), backup))
      // A workout running here lives on this device only: no backup and no server copy holds it,
      // so the import keeps it (in the backup's unit). Only with none running does a backup taken
      // mid-workout bring its own session back. Both the replace and "Merge them in" dropped it.
      const running = carryActive(cur, next) || next.active || null
      // No account: "Merge them in" joins this copy's own entries into the backup's.
      if (mergeWith?.device && !uid) {
        const merged = keepReset(cur, Object.assign(clone(DEF), mergeStates(next, cur, { prefer: 'a' })))
        stampRestore(merged, [cur, next], now)
        merged._ts = now
        merged.active = carryActive({ unit: next.unit, active: running }, merged)
        persist(merged, false)
        return true
      }
      if (!mergeWith?.state || !uid) {
        stampRestore(next, [cur, server], now)
        // …and like a reset of what it replaces: an unsent change of another device from before it
        // no longer brings the replaced workouts back (lib/sync-merge.js stampReplace).
        stampReplace(next, [cur, server].filter(Boolean), now)
        next._ts = now
        next.active = running
        const at = read?.rev != null ? { rev: read.rev, wid: read.state?._wid } : metaOf().base
        // Nothing read (the check could not reach the server) and no base of its own: the push
        // reads the profile first and goes against that read (readForReplace), and the replace is
        // stamped against it as it would have been against the check's, so what that read held is
        // what the backup replaces (NATG-655). Stamped then, at the latest stamp either copy has.
        const prepare = at ? undefined : held => {
          if (!held) return
          const mine = clone(get().S)
          const then = Math.max(Date.now(), highestStamp(mine) + 1, highestStamp(held) + 1)
          stampRestore(mine, [held], then)
          stampReplace(mine, [held], then)
          persist(mine, false)
        }
        get().replaceState(next, !!uid, { baseRev: at?.rev ?? null, baseWid: at?.wid, prepare })
        return true
      }
      // This device's copy as it is now, not only when it owed the server something at check time:
      // what reached it since the check (another import's workouts, a sync) is otherwise left out of
      // a copy that is persisted whole, and gone (NATG-562).
      const others = mergeStates(cur, mergeWith.state)
      // The merge keeps the backup's reset stamp (prefer); a later one this copy or the server's
      // holds stays, as it does on a replace.
      const merged = keepReset(others, keepReset(cur, Object.assign(clone(DEF), mergeStates(next, others, { prefer: 'a' }))))
      stampRestore(merged, [cur, mergeWith.state, next], now)
      merged._ts = now
      merged.active = carryActive({ unit: next.unit, active: running }, merged)
      persist(merged, true)
      if (mergeWith.rev != null) writeSync(mergeWith.rev, 0, mergeWith.state?._wid)
      return true
    },
    // A replace that is meant to reach the server (backup import, reset) is a deliberate
    // overwrite, not a change to merge, and still never a blind one: the push it arms goes against
    // `baseRev` (an import's check read it), so a 409 merges what another device wrote since.
    // Without one it reads the account's profile first and goes against that (readForReplace),
    // `prepare(read)` making the copy what replaces exactly that read. `kind` 'reset' gives a 409
    // its own notice. It never takes the reset stamp back (keepReset).
    replaceState(S, push = false, { baseRev = null, baseWid, kind = 'import', prepare } = {}) {
      if (push) replaceRev = { uid: get().user?.id, kind, rev: baseRev, wid: baseWid, prepare }
      persist(keepReset(get().S, clone(S)), push)
    },

    // Fires after the moments where losing local data would actually hurt — a workout just
    // logged, a routine just edited — not on every keystroke. No-op off mobile or with the
    // setting off; the private file mirror (nativePersist, above) already covers every change.
    autoBackupNow() {
      const S = get().S
      if (MOBILE && S.autoBackup) writeAutoBackup(S)
    },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    // Choosing to go on without a server ends whatever was said about the last one.
    setGuest(v) {
      if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest')
      set({})
      if (v) setSync({ auth: false, offline: false, lastError: null })
    },

    // Public config from /api/config (invite_only, allow_guest). null until the first successful
    // fetch — the login screen and boot both read it, so it is fetched once and cached here
    // rather than by each screen that happens to need it.
    config: null,
    async loadConfig() {
      if (get().config) return get().config
      return get().refreshConfig()
    },
    // Always asks. The cached copy is right for one boot, but an admin can switch the Coach on
    // while a paired phone sits on the setup screen — that screen wants today's answer.
    // Two callers that ask at once get one request: signing in re-asks (setUser) and the pairing
    // flow awaits a refresh of its own immediately after, and there is one answer to have.
    async refreshConfig() {
      if (configFetch) return configFetch
      configFetch = (async () => {
        try { const c = await api('/api/config'); rememberDefaultLang(c); set({ config: c }); get().sharesIfAvailable(); return c }
        catch { return null }
        finally { configFetch = null }
      })()
      return configFetch
    },

    // Routine sharing (GET /api/shares): the caller's two lists as the server last answered,
    // `{ uid, outgoing, incoming, etag, fetchedAt }`, or null before the first answer. Never part
    // of `S`: a share is a record on the server, not something this profile's document holds, and
    // it must not sync or merge. Tagged with whose it is, so a sign-in as someone else never shows
    // the previous profile's list. Saved on this device (SHARED_KEY) and read back at start, so a
    // shared routine stays usable offline at its last-synced version (NATG-486 AC8).
    // `sharesError` is set while the last load failed.
    shares: (() => { const v = readSharedSaved(); return v && v.uid === user0?.id ? v : null })(),
    sharesError: false,
    // Loads the lists once per page for this user, the moment sharing becomes available (a config
    // that says `shares`, a sign-in), so every guard against a custom exercise in a shared routine
    // reads the same answer wherever it is asked. A saved copy from an earlier visit is what the
    // screens show meanwhile; it is not the server's answer, so it does not count as loaded.
    sharesIfAvailable() {
      const { config, user, shares } = get()
      if (sharingAvailable(config, user, { demo: DEMO }) && (sharesFresh !== user.id || !sharesOf(shares, user))) get().loadShares()
    },
    // `newer`: the caller knows of a change the request in flight may predate. That request is
    // still joined, so its callers get their answer, but it may be stale: what a stale one lands is
    // stored and never swept by (NATG-499), and a fresh request goes out the moment it lands
    // (loadSharesNewer waits for that one). `etag`: the `shares` etag the caller saw (the revision
    // poll); the request is stale only if it answers a different one, so a request already as new
    // as that is left alone (NATG-502). Without one (Sync now, an accept, a decline, a removal)
    // the change can't be told from the etag, so the request in flight is always stale.
    async loadShares({ newer = false, etag = null } = {}) {
      const user = get().user
      if (!user) return null
      // A request still out for someone else (a sign-in switch while it was in flight) is not this
      // user's answer: it stores nothing when it lands, so this user gets a request of their own.
      if (sharesFetch?.uid === user.id) {
        if (newer && etag) sharesFetch.seen = etag   // the latest a caller saw is the newest
        else if (newer) sharesFetch.stale = true
        return sharesFetch.promise
      }
      // The pointers in the document as the request leaves (NATG-499): the only ones its answer
      // may sweep. One that arrives after it (a pull, a merge, another tab) may belong to a share
      // accepted after the server answered, so this answer cannot judge it.
      const mine = { uid: user.id, promise: null, stale: false, seen: null, known: new Set(orphanPointers(get().S, [])) }
      sharesFetch = mine
      mine.promise = (async () => {
        try {
          const r = await api('/api/shares')
          if (!answerIsFor(user.id)) return null
          const stale = mine.stale || (mine.seen != null && mine.seen !== (r?.etag || null))
          const stored = sharesOf(get().shares, user)
          // What went is named against the lists as they were before the first stale answer since
          // the last sweep, so a revoke that a stale answer saw first is still told, once.
          const held = sharesBefore?.uid === user.id ? sharesBefore.lists : undefined
          sharesBefore = stale ? { uid: user.id, lists: held === undefined ? stored : held } : null
          const before = held === undefined ? stored : held
          const incoming = Array.isArray(r?.incoming) ? r.incoming : []
          const shares = {
            uid: user.id, outgoing: Array.isArray(r?.outgoing) ? r.outgoing : [], incoming,
            etag: r?.etag || null, fetchedAt: Date.now(),
            // The last name each share showed, for one that is not available right now: the
            // server sends it without its routine, and its row still has to say which it is.
            names: sharedNames(incoming, stored?.names),
          }
          set({ shares, sharesError: false })
          sharesFresh = user.id
          saveShares(shares)
          // A shared routine accepted, changed or gone can make a day a training day or a rest
          // day: the phone's reminders and nudges are scheduled again from the new lists.
          if (MOBILE) syncReminder(get().S)
          // "Off" is the answer while sharing is switched off on the server (it can't be in v1):
          // it says nothing about any one share, so no pointer is judged by it.
          // This request is done: what follows may start the next one.
          if (sharesFetch === mine) sharesFetch = null
          if (stale) {
            // Older than a change the caller knew of: no sweep, and the lists load again now.
            get().loadShares()
          } else if (shares.etag !== 'off' && Array.isArray(r?.incoming)) {
            if (get().ready && !adoptHold) get().sweepSharedPointers(before, mine.known)
            else sweepOwed = { uid: user.id, known: mine.known }
          }
          return shares
        } catch {
          // The lists held now may be older than the server's (a stale answer whose fresh request
          // failed, NATG-511): their etag is forgotten in memory, so the next revision poll can't
          // take them as current and loads again. No retry of its own.
          if (answerIsFor(user.id)) {
            const held = sharesOf(get().shares, user)
            set({ sharesError: true, ...(held ? { shares: { ...held, etag: null } } : {}) })
          }
          return null
        } finally { if (sharesFetch === mine) sharesFetch = null }
      })()
      return mine.promise
    },
    // The lists as the server has them now, not as a request already in flight will answer: joins
    // that request, then waits for each newer one for the same user until the one it waited for
    // was the latest, so it settles only after the last of them has swept (NATG-522). A follow-up
    // can be made stale too (Sync now, another Remove), and a Remove's mark has to outlast the
    // sweep that would name its share. At most SHARES_NEWER_MAX follow-ups: past that it returns,
    // and the request still out sweeps as usual. Never rejects (loadShares answers null on failure).
    // `etag`: the `shares` etag the caller saw, if it knows one (see loadShares).
    async loadSharesNewer(etag = null) {
      const uid = get().user?.id   // the user this call is for: a request for whoever signs in next is not waited on
      let answer = await get().loadShares({ newer: true, etag })
      for (let n = 0; n < SHARES_NEWER_MAX; n++) {
        if (!uid || sharesFetch?.uid !== uid) break
        answer = await sharesFetch.promise
      }
      return answer
    },
    // A share that is gone from the lists (revoked, its routine deleted, removed or declined on
    // another device) leaves your schedule too, through the same delete your own routines use, so
    // the removal is stamped and your other devices agree after their own merge (NATG-486 AC6). A
    // share that is only not available right now keeps its days (AC9). Only after a load from the
    // server in this page: a saved copy can be older than a share accepted on another device.
    // `before` (the lists as they were) names, once, each accepted share that went.
    // `known` (NATG-499): the pointers the document held when the request for these lists left.
    // Only those are swept; a pointer that arrived later is left, and the lists load again so it
    // is judged by an answer that is at least as new as it.
    sweepSharedPointers(before = null, known = null) {
      const { shares, user } = get()
      const mine = sharesOf(shares, user)
      if (!mine || sharesFresh !== user.id) return
      const orphans = orphanPointers(get().S, mine.incoming)
      const gone = known ? orphans.filter(id => known.has(id)) : orphans
      if (gone.length) get().update(s => { for (const id of gone) deleteRoutine(s, id) })
      if (gone.length < orphans.length && !sharesFetch) get().loadShares()
      const removing = sharesRemoving.get(user.id)
      const left = (before?.incoming || []).filter(i => i && i.state === 'accepted' && !mine.incoming.some(x => x && x.id === i.id) && !(removing?.get(i.id) > 0))
      if (!left.length) return
      import('./useUI.js').then(({ useUI }) => {
        for (const i of left) {
          const name = shareNameOf(i) || t('A shared routine')
          useUI.getState().toast(gone.includes(sharedPointer(i.id))
            ? t('{0} is no longer shared with you. It’s off your schedule too.', name)
            : t('{0} is no longer shared with you.', name))
        }
      }).catch(() => {})
    },
    // The recipient's three answers (POST accept or decline, DELETE to remove). Each needs the
    // server; a failure is thrown for the screen to say why. The lists load again afterwards, from a
    // request that left after the answer (loadSharesNewer), so a request already in flight can't
    // show the share as it was; a removal takes the share off your schedule at once, the way
    // deleting a routine does.
    async acceptShare(id) {
      try { return await api('/api/shares/' + encodeURIComponent(id) + '/accept', { method: 'POST', body: '{}' }) }
      finally { await get().loadSharesNewer() }
    },
    async declineShare(id) {
      try { return await api('/api/shares/' + encodeURIComponent(id) + '/decline', { method: 'POST', body: '{}' }) }
      finally { await get().loadSharesNewer() }
    },
    async removeShare(id) {
      // Marked as being removed until the reload below has settled, on every path: a DELETE the
      // server applied but whose answer failed is covered too (sharesRemoving).
      const uid = get().user?.id
      if (uid) {
        const counts = sharesRemoving.get(uid) || new Map()
        counts.set(id, (counts.get(id) || 0) + 1)
        sharesRemoving.set(uid, counts)
      }
      const reload = () => get().loadSharesNewer().finally(() => {
        if (!uid) return
        const counts = sharesRemoving.get(uid)
        if (!counts?.has(id)) return
        if (counts.get(id) > 1) counts.set(id, counts.get(id) - 1)
        else { counts.delete(id); if (!counts.size) sharesRemoving.delete(uid) }
      })
      try {
        await api('/api/shares/' + encodeURIComponent(id), { method: 'DELETE' })
      } catch (e) {
        // Already gone on the server (revoked meanwhile): the outcome asked for, so it is no error.
        if ((e?.data?.code || e?.code) !== 'share-missing') { reload(); throw e }
      }
      // The reload runs whatever happens here, so nothing thrown below can leave the mark held.
      try {
        // Signed out, or another account, meanwhile: nothing of this one's is changed or saved here.
        if (!answerIsFor(uid)) return true   // the removal itself went through
        const user = get().user
        // Answered after a switch to another account: the removal was the account that asked, and
        // what is held now belongs to the one signed in since. Nothing is written into its lists
        // or its copy, where a delete that finds nothing would still stamp a change and push it
        // (NATG-531). The asking account's pointer goes on its next load (sweepSharedPointers);
        // the reload in `finally` still runs.
        if (user?.id !== uid) return true
        const mine = sharesOf(get().shares, user)
        if (mine) {
          const shares = { ...mine, incoming: mine.incoming.filter(i => i?.id !== id) }
          set({ shares })
          saveShares(shares)
        }
        // Nor is it named as gone by the next load: the user removed it.
        // Only for a user still signed in: after a sign-out there is nobody to hold lists for.
        const held = user && sharesBefore?.uid === user.id ? sharesBefore.lists : null
        if (held) sharesBefore = { uid: user.id, lists: { ...held, incoming: held.incoming.filter(i => i?.id !== id) } }
        get().update(s => { deleteRoutine(s, sharedPointer(id)) })
      } finally { reload() }
      return true
    },

    // `adopt` (a sign-in, a pairing — { alwaysAsk } for a device link): adoptProfile follows and
    // decides what becomes of this copy; until it has, nothing is pulled or pushed (ADOPT_KEY).
    setUser(u, { adopt } = {}) {
      // Every change of account here ends the imports begun under the previous one: a sign-in as
      // someone else, a session that expired (a 401), and the same account signing in again.
      if ((get().user?.id || null) !== (u?.id || null)) ownerEpoch++
      if (u) {
        // The local copy belongs to whoever last signed in here. When a session expires or is
        // revoked elsewhere, boot() only drops the user and the data stays; a different profile
        // signing in next must not inherit it (pullState would push it into that account, and
        // carry the in-progress workout along) — what it still owed its own account is kept aside
        // for that account first (keepForPrevious). A proper sign-out clears the owner, so a guest's
        // data still moves into a freshly created profile. The same account coming back — a
        // phone paired again, a browser signed in again — is remembered for adoptProfile.
        const owner = localStorage.getItem('gym_owner')
        rejoined = owner === u.id
        const other = !!owner && owner !== u.id
        // A sign-in, or another account: a new token before the owner key is written. Not boot's
        // own setUser for the owner already here, or its 401 check below would always find it moved.
        if (adopt || owner !== u.id) bumpOwnerGen()
        // The hold goes on before anything else can run: a poll, a resume, a debounced push.
        // A replace a reset or an import armed for that push goes with it: the adoption decides
        // what this copy is, and pushes it against the server's revision. Left armed, it went out
        // with the next account's first push, over what another device had synced (NATG-572).
        if (adopt) {
          adoptHold = true
          clearTimeout(pushTm)
          pushTm = null
          replaceRev = null
          adoptWrite = null
        } else {
          // Boot signing the account back in: an adoption it still owes holds sync until it is
          // answered (resumeAdoption); one another account left behind is void.
          const m = readAdopt()
          if (m && m.uid !== u.id) writeAdopt(null)
          adoptHold = !!m && m.uid === u.id
        }
        // What another tab of this browser saved under the copy's owner so far is this copy's
        // too: the question below is about it, and from here on this tab joins only the
        // account's saves (seenOwner below).
        syncFromSaved()
        if (other) {
          keepForPrevious(owner)
          forgetSync()
          localStorage.removeItem(KEY)
          // The new owner before the new copy, as on a sign-out: another tab still holding the
          // previous account's copy must not join it into this one (QA 2026-10-06).
          localStorage.setItem('gym_owner_name', u.name || '')
          localStorage.setItem('gym_owner', u.id)
          seenOwner = u.id
          persist(restartedState(get().S), false)
          setSync({ pending: false, lastSynced: 0, lastError: null })
        }
        // The mark, with the names of what this copy holds now (`pre`) — what the question is
        // about; whatever is logged later belongs to the account (runAdopt).
        if (adopt) writeAdopt({ uid: u.id, rejoined, alwaysAsk: !!adopt.alwaysAsk, pre: preOf(get().S) })
        localStorage.setItem('gym_owner_name', u.name || '')
        localStorage.setItem('gym_owner', u.id)
        // This tab now joins the account's saves like any tab opened on it: one opened after the
        // sign-in saves under the new owner, and a tab still comparing against the old one took
        // no part until it had saved itself, then wrote its copy over theirs (joinSaved).
        seenOwner = u.id
        handedOver = false
        localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest')
        logoutOwed(false)   // this sign-in's cookie replaced the one a failed sign-out left behind
        // A profile created here (no question: this copy becomes it) is saved once under its owner
        // now. Another tab of this browser takes only a copy saved under the new owner, and went
        // blank until this one happened to save something (takeSaved).
        if (!adopt && !other && owner !== u.id) persist(get().S, false, false)
        // The file follows at once, as the new account's: until then it holds the previous one's.
        if (other && MOBILE) nativePersist(true)
        // The server answers /api/config with a `coach` key only to a session — the block, or
        // null on an instance that has no Coach. So a copy with no key at all is one fetched
        // before this sign-in (boot's, or the login screen asking for invite_only), and every
        // Coach entry point would stay hidden until the next reload. Ask again, unawaited:
        // nothing on this path waits for the answer. A copy that has the key was made for a
        // session and is already the right answer, Coach or no Coach.
        if (get().config && !('coach' in get().config)) get().refreshConfig()
      } else { rejoined = false; adoptHold = false; localStorage.removeItem('gym_user') }
      set({ user: u })
      setSync({ held: adoptHold })
      if (u) get().sharesIfAvailable()
    },

    // One PUT at a time: a push asked for while one is in flight runs after it (once, however
    // many asked), and the promise returned covers that follow-up too, so a caller that awaits
    // before signing out knows the last change is on the server.
    async pushState() {
      if (!get().user) return
      clearTimeout(pushTm)
      pushTm = null
      if (adoptHold) return   // the sign-in has not decided what this copy is yet (adoptProfile)
      if (pushing) { pushAgain = get().user.id; return pushing.then(() => pushing) }
      pushing = doPush().finally(() => {
        pushing = null
        // A follow-up asked for by an account that has gone since is dropped, not sent under the
        // session the browser holds now (SEC-01).
        const again = pushAgain
        pushAgain = false
        if (again && answerIsFor(again)) get().pushState()
      })
      return pushing
    },
    // Ask the server for its copy and settle the difference. Coalesced, and a push still waiting
    // in the debounce goes first — the server's answer is then the one that already includes it,
    // and the push itself is what catches a conflict.
    async pullState() {
      if (adoptHold) return   // as pushState: adoptProfile reads the server itself
      // As loadShares (NATG-493): the request is kept with the user it is for. An answer that lands
      // once that user has gone (a sign-out or another account signing in, in this tab or another)
      // is not this copy's: it is dropped, neither taken nor saved (NATG-496), and the user signed
      // in now gets a request of their own.
      const uid = get().user?.id
      if (!uid) return   // nobody signed in: there is no account to ask for (SEC-02)
      if (pulling && pulling.uid === uid) return pulling.promise
      const mine = { uid, promise: null }
      pulling = mine
      mine.promise = (async () => {
        try {
          // A replace still to read the profile goes first as well: its push reads the server
          // itself, and a merge before it would bring back what the reset or import replaces.
          if (pushTm || owesRead(uid)) { clearTimeout(pushTm); pushTm = null; await get().pushState() }
          else if (pushing) await pushing
          if (!answerIsFor(uid)) return
          const res = await api('/api/data')
          if (!answerIsFor(uid)) return
          // A sign-in's question opened meanwhile (an adoption's write met a profile that appeared,
          // doPush): the adoption settles this copy, not this pull.
          if (adoptHold) return
          // A copy whose base is another account's is settled no way at all: every branch below
          // would drop or restamp that base on its way to a push or an adopt, and the push check
          // would then find this account's base on the other account's copy. Only a sign-out or a
          // switch (forgetSync) clears it; until then nothing is written and the error stays.
          const held = metaOf().base
          if (held && held.uid !== uid) { refuse('pull', held.uid, uid); return }
          lastCheck = Date.now()
          reached()
          const { state, rev } = res
          noteRevless(uid, rev == null)
          const S = get().S
          const { base, owed } = metaOf()
          // Owed to the server: a push that failed, or a change made while boot was still pulling.
          const dirty = owed || pushPending
          // A server from before revisions: the old rule, newer `_ts` wins outright.
          if (rev == null) {
            dropSync()
            const restored = restoredStateFor(S, state, dirty)
            if (restored) { persist(restored, false, false); confirmed(get().S) }
            else if (hasData(S)) await get().pushState()
            return
          }
          // No base yet — first pull on this device, or a client that just learned about
          // revisions. The newer copy wins as before, except that a copy still owed to the
          // server (dirty) is merged instead of pushed over whatever is there.
          if (!base) {
            if (dirty && state) {
              // The base the merge stands on: the revision just read, as mergeInto would record it.
              writeSync(rev, 0, state?._wid)
              if (!mergeInto(S, state, rev)) return
              pushPending = false
              await get().pushState()
              return
            }
            const restored = restoredStateFor(S, state, false)
            if (restored) { adopt(restored, rev); confirmed(get().S) }
            else if (hasData(S)) { writeSync(rev, 0, state?._wid); await get().pushState() }
            else { writeSync(rev, state?._ts || 0, state?._wid); confirmed(get().S) }
            return
          }
          // The document the server holds now, and whether it descends from the one this copy last
          // synced: one it does not (the server's data went back in time — a restored backup, a
          // write lost to a power cut — or an answer that left before this device's own push
          // landed) is never taken as it is. It is merged, and pushed: what this device had
          // confirmed would otherwise vanish here too, and the same revision number can name a
          // different document, which a push would have overwritten without a 409.
          const wid = state?._wid
          const serverMoved = rev !== base.rev || (!!base.wid && !!wid && wid !== base.wid)
          const descends = !base.wid || !wid || wid === base.wid || (Array.isArray(state?._wids) && state._wids.includes(base.wid))
          const changed = dirty || localChanged(S)
          if (!serverMoved) { if (changed) await get().pushState(); else confirmed(S); return }
          if (!state) { writeSync(rev, 0); if (hasData(S)) await get().pushState(); return }
          if (!descends) { if (!mergeInto(S, state, rev)) return; pushPending = false; await get().pushState(); return }
          if (!changed) { const next = sanitizeAccent(Object.assign(clone(DEF), state)); next.active = carryActive(S, next); adopt(next, rev); confirmed(get().S); return }
          if (!mergeInto(S, state, rev)) return
          pushPending = false
          await get().pushState()
        } catch (e) { if (answerIsFor(uid)) failed(e) /* keep local; the poll retries */ }
        finally { if (pulling === mine) pulling = null }
      })()
      return mine.promise
    },

    // "Sync now": what is waiting goes, the server's copy is checked, and the answer is the
    // `sync` every screen reads — status 'ok' when the two agree.
    async syncNow() {
      if (!get().user) { setSync({}); return get().sync }
      // Held for a sign-in's question: "Sync now" is asking it (again), and the sync follows.
      if (adoptHold) { await get().resumeAdoption(); if (adoptHold) return get().sync }
      if (pulling) await pulling.promise
      // The share lists first, then the document, the order checkRev keeps (NATG-501): a sharer's
      // edit, a revoke or a share that is no longer available shows after Sync now too, and a
      // pointer the document brings is judged by lists at least as new as it.
      const { config, user, shares } = get()
      if (sharingAvailable(config, user, { demo: DEMO }) || sharesOf(shares, user)) await get().loadSharesNewer()
      await get().pullState()
      return get().sync
    },

    // What this device holds that the server has not seen: `owed` when anything would be lost by
    // wiping the copy now, `count` how many workouts, weigh-ins, routines and custom exercises
    // differ from the last copy the two agreed on (plus one for settings and the plan) — null
    // when the device has no record of that copy (it last agreed with the server under an older
    // version), and then only `owed` is known.
    //
    // `media` counts the custom exercises whose photo or video the server has not confirmed
    // (lib/media-owed.js); present only when there are any, and they are owed on their own.
    unsyncedChanges() {
      if (!get().user) return { owed: false, count: 0 }
      const media = pendingRefCount(get().S)
      const withMedia = media ? { media } : {}
      if (!owes()) return { owed: media > 0, count: 0, ...withMedia }
      const count = countChanges(get().S, readFingerprint())
      return { owed: count !== 0 || media > 0, count, ...withMedia }
    },

    // The changes a forced sign-out or disconnect kept on this device, waiting for their server
    // and account: [{ server, uid, name, at }] — server null for a phone whose pairing was lost
    // with its address. The copies themselves stay inside the store. `keptRev` moves whenever
    // they change, for a screen listing them to ask again.
    keptRev: 0,
    async keptChanges() {
      const all = await readStashes()
      return Object.values(all).map(({ server, uid, name, at }) => ({ server: server || null, uid, name, at }))
    },
    // The copy kept for one account (keptChanges' server and uid), to save as a backup file.
    async keptState(server, uid) {
      const all = await readStashes()
      return all[stashKey(server, uid)]?.state || null
    },
    // Every photo and video file the stashes refer to: they are kept on this device for as long
    // as the stash is (lib/media-sync.js localMediaGc, Reset everything).
    async stashedMediaHashes() {
      const all = await readStashes()
      return new Set(Object.values(all).flatMap(e => [...referencedHashes(e?.state)]))
    },

    // Sign-in (and pairing a phone) takes the server's profile as this device's copy — the
    // profile is the truth for a signed-in user, whatever the timestamps say. The only thing
    // the device may add are the entries it logged while signed out: `ask(extras)` (a dialog,
    // supplied by the caller) decides whether those workouts, weigh-ins and custom exercises
    // are added to the profile or dropped. A profile with no state yet simply takes the
    // device's data, as creating a profile always did. The same account signing in again is
    // different: see below.
    //
    // `alwaysAsk` is for a profile this device joins with a code from another device (#95,
    // DeviceLinkRedeemSheet). Nothing proves that profile is this person's own — whoever sends
    // the code chooses it — so what a guest logged here is not moved into it unasked, not even
    // into one with no state yet, where it would otherwise go without a word. Declined, this
    // device takes that empty profile as it is, the way it takes a profile that has state.
    //
    // Nothing syncs from the sign-in until the answer is in (setUser's `adopt`, ADOPT_KEY): a poll or
    // a resume pull in the meantime took the device's copy for a newer one of the account's and
    // pushed it over the profile. And the answer is applied to the server's copy as it is once the
    // question closes, not as it was when it opened — another device may have written meanwhile.
    // Calls made while one is running get that one.
    adoptProfile(ask, opts = {}) {
      if (adopting) return adopting
      setHold(true)
      // Whatever throws on the way (the server, the question itself): a sign-in that marked it
      // stays held, and the next check or "Sync now" runs it again; a bare call has nothing to
      // hold for and lets go.
      adopting = runAdopt(ask, opts)
        // A refused merge (NATG-556) claims nothing: saved again here, the other account's copy
        // would be tagged as this one's.
        .then(r => { if (!r?.refused) claimSaved(); return r })
        .catch(e => { if (!adoptOwed()) releaseAdopt(); throw e })
        .finally(() => { adopting = null })
      return adopting
    },
    // The adoption a sign-in still owes — the app was closed with its question open, or the server
    // could not be reached for it: asked again, with the sign-in's own question.
    async resumeAdoption(ask) {
      const m = adoptOwed()
      if (!m) { if (adoptHold && !adopting) releaseAdopt(); return null }
      if (adopting) return adopting
      try {
        if (typeof ask !== 'function') ask = (await import('../sheets.jsx')).askAddDeviceData
        const r = await get().adoptProfile(ask, { alwaysAsk: !!m.alwaysAsk })
        // A phone whose pairing ended here: what connectToServer does after its own adoption.
        if (MOBILE) { await nativePersist(true); if (get().needsMobileOnboarding) set({ needsMobileOnboarding: false, permSteps: true }) }
        return r
      } catch { return null }
    },

    /* Signing out wipes this device's copy — never while it holds changes the server has not
       seen. After one more push, if anything is still owed, nothing is wiped and the result
       says so: { owed: true, count } (see unsyncedChanges), for the screen to offer a retry, an
       export, or going ahead anyway. `force` goes ahead: the owed copy is kept aside on this
       device (stashOwed) and comes back when it next reaches this server as this account. If
       even that cannot be written, nothing is wiped ({ owed, count, stashed: false }).
       Otherwise { owed: false } or { owed: true, count, stashed: true }, signed out. A workout
       running here is kept aside either way (stashActive), and the rest and hold timers stop.
       Another tab signing a different account in before the logout is sent cancels it: nothing
       is sent or wiped, and the result is { cancelled: true } (overtaken). `owner`: the account
       the sign-out was asked for under, when that was before this call (a "Try again" or "Sign
       out anyway" from the owed sheet, leaveServer); by default the browser's owner now. */
    async signOut({ force = false, owner = readOwner() } = {}) {
      await settle()
      if (overtaken(owner)) return { cancelled: true }
      const left = get().unsyncedChanges()
      if (left.owed && !force) return owedResult(left)
      await stopTimers()
      if (left.owed && !(await stashOwed())) return owedResult(left, { stashed: false })
      if (!left.owed && !(await stashActive())) return { owed: true, count: 0, stashed: false }
      // Checked again right before the request: the stash and the timers wait too.
      if (overtaken(owner)) return { cancelled: true }
      // The device is signed out either way. A request that did not get through leaves the cookie
      // behind, still valid, so the logout is owed until the server answers it (see boot).
      try { await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { if (!MOBILE) logoutOwed(true) }
      await clearLocalSession()
      return left.owed ? owedResult(left, { stashed: true }) : { owed: false }
    },

    // Mobile-only ("connect to my server" onboarding, see App.jsx's needsMobileOnboarding).
    // Picking local — even before there's any data — persists the choice so onboarding never
    // asks again.
    async chooseLocalMode() {
      await chooseLocal()
      set({ needsMobileOnboarding: false, permSteps: true })
    },
    // Redeems the pairing code shown in the browser (Settings → "Pair the mobile app") and
    // switches this device over to that account, same as signing in on the web does — the same
    // account pairing again merges what the phone kept (adoptProfile).
    async connectToServer(url, code, ask) {
      const user = await connect(url, code)   // throws on a bad URL/expired code — caller shows it
      // The account first, the address after: a copy another account still owed is kept aside
      // for it under the server it belongs to, not the one being paired.
      get().setUser(user, { adopt: true })
      if (keeping) { await keeping; keeping = null }
      pairedBase = normalizeServerUrl(url)
      setSync({ server: pairedBase })
      await get().refreshConfig()   // what this server offers (the Coach, guest mode) — see boot()
      await get().adoptProfile(ask)
      await nativePersist(true)   // the file holds this account's copy before anything else can happen
      // Paired from the first-launch screen: the permission steps come next. From Settings later
      // on, nothing new is asked here.
      set(st => ({ needsMobileOnboarding: false, permSteps: st.permSteps || st.needsMobileOnboarding }))
    },
    // Leaves remote mode and drops back to local-only, the way signOut does: never with changes
    // the server has not seen, unless `force` keeps them aside first. Same result as signOut;
    // the phone stays paired when that comes back owed and not stashed, or cancelled.
    async disconnectServer(opts) {
      const r = await get().signOut(opts)
      if (r.cancelled || (r.owed && !r.stashed)) return r
      await forgetRemote()
      pairedBase = null
      setSync({ server: null })
      get().setGuest(true)
      set({ ready: true })
      return r
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it, under the same rule about changes still owed. Unlike
    // signOut the request is NOT swallowed: if it fails the sessions elsewhere are all still
    // valid, and wiping this device's copy of the data would sign the user out of the one place
    // the bump didn't reach. Caller reports the error. Cancelled like signOut ({ cancelled: true }),
    // against the same `owner`.
    async signOutAll({ force = false, owner = readOwner() } = {}) {
      await settle()
      if (overtaken(owner)) return { cancelled: true }
      const left = get().unsyncedChanges()
      if (left.owed && !force) return owedResult(left)
      await stopTimers()
      if (overtaken(owner)) return { cancelled: true }
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      if (left.owed && !(await stashOwed())) return owedResult(left, { stashed: false })
      if (!left.owed && !(await stashActive())) return { owed: true, count: 0, stashed: false }
      await clearLocalSession()
      return left.owed ? owedResult(left, { stashed: true }) : { owed: false }
    },

    // Settings → "Delete my account": the server removes the profile and everything of it
    // (POST /api/account/delete, `name` typed back to confirm, `proof` the owner's: a passkey
    // assertion or the current password, from ProveOwner in components/PasswordAuth.jsx), then
    // this device ends where a sign-out leaves it, and a phone goes back to local-only as a
    // disconnect does. Nothing is kept aside: there is no account left for kept changes or a
    // running workout to come back to. The request is not swallowed: refused (the name, the
    // proof, the last admin) or not answered, nothing here changes and the caller says why.
    async deleteAccount(name, proof = {}) {
      const uid = get().user?.id
      await api('/api/account/delete', { method: 'POST', body: JSON.stringify({ name, ...proof }) })
      await stopTimers()
      const all = await readStashes()
      const key = stashKey(serverBase(), uid)
      if (all[key]) { delete all[key]; await writeStashes(all) }
      await clearLocalSession()
      if (MOBILE) {
        await forgetRemote()
        pairedBase = null
        setSync({ server: null })
        get().setGuest(true)
        set({ ready: true })
      }
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      markOwed(false)
      persist(Object.assign(clone(DEF), buildDemoState()), false)
      // The demo's photos and videos were only ever in this browser, and the reset takes them too.
      await mediaStore.clearAll().catch(() => {})
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend by default — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in. Unless this
      // device was paired to a server ("connect to my server" mode, lib/remote.js), in which
      // case it behaves exactly like the signed-in web flow below, straight from here.
      if (MOBILE) {
        const remote = await loadRemote()
        // Before the first request: a server behind Cloudflare Access answers nothing without it.
        await loadCfAccess({ pairedBase: remote?.mode === 'remote' ? remote.base : '' })
        set({ coachLocal: coachDeviceSettings(await loadCoachDevice()) })
        if (remote?.mode === 'remote') {
          setRemoteAuth(remote.base, remote.token)
          pairedBase = remote.base || null
          setSync({ server: pairedBase })
          await restoreFromMirror(remote)
          // The share lists' file, when WebView storage lost its copy: this account's only.
          if (!get().shares) {
            const saved = await readJsonFile(SHARED_FILE)
            const who = get().user?.id || readOwner()
            if (saved && typeof saved === 'object' && saved.uid && saved.uid === who) set({ shares: saved })
          }
          try {
            const me = await api('/api/me')   // also catches a token revoked elsewhere (sign out everywhere)
            if (!me.user?.id) throw Object.assign(new Error('no user'), { status: 200, code: 'bad-response' })
            // A token past half its life comes back renewed: kept, it never runs out on a phone
            // that is used at all.
            if (typeof me.token === 'string' && me.token) await renewToken(remote, me.token)
            get().setUser(me.user)
            // The paired server's /api/config, the same one the web boot reads: without it the
            // phone never learned whether the server offers the Coach and told everyone "your
            // server has no Coach enabled" — with the admin looking at a green test.
            await get().loadConfig()
            // Closed with the pairing's question still open: asked again, and nothing is pulled
            // or pushed until it is answered — this copy may still be the one from before pairing.
            if (adoptOwed()) {
              syncReminder(get().S)
              finishBoot()
              // The adoption applies what the pull would have (its stash included); the reminder
              // then follows the copy it settled on.
              get().resumeAdoption().then(() => syncReminder(get().S))
              return
            }
            await get().pullState()
            if (!get().sync.lastError) await applyStash()   // only once the server really answered
          } catch (e) {
            // Whatever the answer — no network, a server error, a token the server no longer
            // accepts — the pairing, this copy and the account all stay, and what is owed stays
            // owed. A refused token used to unpair the phone on the spot while it went on showing
            // the account: every change after that "synced" into the app's own files (see
            // lib/api.js) and was gone on the next Disconnect. Now the screens say the server
            // refuses this phone, and pairing it again merges what it kept.
            get().setUser(remote.user || get().user)
            failed(e, { pending: owes() })
          }
          syncReminder(get().S)
          finishBoot()
          return
        }
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          persist(sanitizeAccent(Object.assign(clone(DEF), saved)), false, false)
        } else if (hasData(S)) {
          nativePersist(true)   // first run after an update from a file-less version: seed the mirror
        }
        if (get().user) {
          // A phone that lost its pairing to a refused token under an earlier version: that boot
          // dropped the pairing file — address and token with it — but not the account, and every
          // push since "landed" on the WebView's own asset server. No other path leaves an
          // account in local mode (Disconnect and "keep it on this phone" both leave none), so
          // this is that phone. What it holds stays owed, and the screens say it has to be paired
          // again; the address is gone, so pairing asks for it.
          markOwed(true)
          failed({ status: 0, code: 'not-paired' }, { pending: true })
        } else get().setGuest(true)
        syncReminder(get().S)
        // Only a genuinely first launch — nothing chosen yet and nothing to lose either — offers
        // the choice. Picking local (even with no data yet) persists that choice below and this
        // never asks again.
        finishBoot({ needsMobileOnboarding: !remote && !hasData(get().S) })
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        finishBoot()
        return
      }
      // Opened from a device-link QR code (#95): the code comes off the address at once — a reload,
      // a bookmark or a shared screenshot of the address bar must not carry it around — and waits
      // here for the sheet that redeems it (App.jsx, components/Passkeys.jsx).
      // Whose copy this tab loaded, before anything here waits (SEC-03). Another tab can sign out,
      // or in as someone else, while this boot is out asking: from then on the session the
      // browser holds is not this copy's, and setUser would relabel this copy (and its revision)
      // as the new account's, and sync it into that account. Checked after every wait below; once
      // it has moved, boot ends signed out and this tab follows the other one (the owner event,
      // takeSaved, followSignIn), as any tab whose owner changed under it does. A sign-out and
      // sign-in as the same account leaves the owner key where it was: the token shows it (NATG-606).
      const owner0 = seenOwner
      const gen0 = readOwnerGen()
      const moved = () => readOwner() !== owner0 || readOwnerGen() !== gen0
      const linkCode = linkTokenFromSearch(window.location.search)
      if (linkCode) { stripLinkFromUrl(); set({ linkCode }) }
      // Guests never authenticate, so an instance that turned guest mode off has no request to
      // refuse — the only way the switch reaches someone already inside is here, on their next
      // boot. Ending the session needs a positive `allow_guest: false`; see lib/guest.js for why
      // an unreachable server must not be allowed to lock anyone out (#42).
      const cfg = await get().loadConfig()
      if (moved()) { finishBoot(); return }
      if (!guestAllowed(cfg)) get().setGuest(false)
      // A sign-out that could not reach the server: finish it first. Still unanswered, the
      // browser stays signed out rather than adopt the session it left behind.
      if (logoutOwed()) {
        try { await api('/api/logout', { method: 'POST', body: '{}' }); logoutOwed(false) } catch { /* owed until it is answered */ }
        if (logoutOwed() || moved()) { finishBoot(); return }
      }
      try {
        if (moved()) { finishBoot(); return }
        const me = await api('/api/me')
        // The answer is about the session the browser holds now: one this copy's owner no longer
        // has (another tab signed out or in meanwhile), or a sign-out still owed, is not signed in
        // here, and setUser would sign it back in.
        if (moved() || logoutOwed()) { finishBoot(); return }
        if (!me.user?.id) throw Object.assign(new Error('no user'), { status: 200, code: 'bad-response' })
        get().setUser(me.user)
        const uid = me.user.id
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings. Only while the account boot signed in is still this
        // tab's (SEC-04): run after a wait (the pull, the stash, the sign-in's question), it could
        // find the owner moved with this tab not yet told, and update() then saved the departed
        // account's whole copy under the new owner.
        const restampTz = () => {
          if (!answerIsFor(uid)) return
          const tz = localTZ()
          if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
            get().update(s => { s.reminder = { ...s.reminder, tz } })
          }
        }
        // Closed with the sign-in's question still open: asked again once the app is up (see the
        // phone's boot above); the adoption applies the stash, the timezone follows its copy.
        if (adoptOwed()) {
          finishBoot()
          get().resumeAdoption().then(() => { if (!adoptHold) restampTz() })
          return
        }
        await get().pullState()
        if (!get().sync.lastError) await applyStash()   // only once the server really answered
        restampTz()
      } catch (e) {
        // The session ended (expired, revoked, signed out everywhere): back to the sign-in
        // screen, which says so. The copy stays here with its owner, and signing in again as the
        // same account merges it (adoptProfile). A later reload still says so while that copy
        // owes its account changes — the user is gone by then, the owner and the copy are not —
        // unless whoever is here chose to go on as a guest. A 401 that lands after another tab
        // signed out or in is about the session this copy's owner had, not the browser's now:
        // setUser(null) would remove the new account's gym_user, so this tab only follows the
        // other one (the owner event), as boot's other waits do (NATG-574). So does one that lands
        // after the same account signed in again, with or without a sign-out first (NATG-606).
        if (e.status === 401) {
          if (moved()) { finishBoot(); return }
          const kept = !!get().user || (!get().isGuest() && !!localStorage.getItem('gym_owner') && owes())
          get().setUser(null)
          if (kept) failed(e, { pending: owes() })
        }
        // Started without a network (a home-screen app reopened in the gym's basement), or
        // behind a proxy answering for the server: keep the signed-in copy and say so from the
        // first screen, not only after the first failed push.
        else if (get().user) failed(e, { pending: owes() })
      }
      finishBoot()
    }
  }
})

// The phone's reminders and nudges count the routines shared with you (lib/mobile.js).
setSharedSource(() => sharedViewOf(useStore.getState()))

export { hasData }
