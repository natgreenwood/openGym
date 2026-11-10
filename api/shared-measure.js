// What of a sharer's routine leaves the server for a recipient, and how much it weighs: the
// projection and the size cap of api/shared-routine.js (NATG-483, NATG-494), which re-exports all
// of it. Kept apart from that module because the app imports this one too (NATG-670): the routine
// page warns a sharer as soon as an edit takes a shared routine over the cap, and the warning has
// to agree with the server to the byte. So nothing here may be Node-only, as with api/coach/core
// (frontend/vite.config.js server.fs): no node:crypto, no Buffer. The byte count comes from
// TextEncoder, which Node and every browser have and which encodes a lone surrogate as U+FFFD,
// three bytes, exactly as Buffer.byteLength counts it. The content hash, which needs node:crypto,
// stays in shared-routine.js.
//
// The web image copies this file next to frontend/ (web/Dockerfile) and the api image lists it
// (api/Dockerfile): rename or move it in all three places.

const utf8 = new TextEncoder();
/** The UTF-8 length of `s`, the same number in Node and in a browser. */
const utf8Length = s => utf8.encode(s).length;

export const ROUTINE_FIELDS = ['id', 'name', 'emoji', 'prog', 'excludeFromProgression'];
// Every field cleanEx can write, except `subs` (planned backups): the plan export keeps the
// catalogue's ones, but the API has no catalogue to tell them from the sharer's own exercises.
export const SLOT_FIELDS = [
  'id', 'sets', 'mode', 'min', 'speed', 'incline', 'sec', 'weight', 'reps',
  'pyramid', 'pyramidRest', 'pyramidWeight', 'bodyweight', 'side', 'prog', 'inc', 'backoff',
  'lastToFailure', 'deloadFactor', 'dbLoad', 'repsMin', 'setsMax', 'repsMax', 'restSec', 'restOff',
  'warmupRestSec', 'warmupRestOff', 'sideRestOff', 'sideRestSec', 'sg', 'sgName', 'sgRest', 'note',
  'warmupSets', 'intensifier',
];
// Kept by cleanEx and deliberately not here.
export const SLOT_WITHHELD = ['subs'];

const isEntry = x => x && typeof x === 'object' && !Array.isArray(x);
// A value from parsed JSON that is meant to be text: a caller-supplied field, or a sharer's
// value another user is shown. String() alone is not safe on a parsed body:
// `{"code":{"toString":1}}` is valid JSON and String() throws on it. A string stays, a number
// becomes one, anything else is empty. server.js uses this one for its own callers too.
export const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const isSharedSlot = e => isEntry(e) && typeof e.id === 'string';
/** The slots of `r` a recipient gets, before their fields are picked: entries with a string id. */
export const sharedSlots = r => (Array.isArray(r.ex) ? r.ex : []).filter(isSharedSlot);
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (Object.hasOwn(o, k) && o[k] !== undefined) out[k] = o[k];
  return out;
};

// The most a shared routine's projection may weigh: the UTF-8 bytes of
// JSON.stringify(sharedRoutine(r)). A routine with every field set and a note on each slot is a
// few hundred bytes per slot, so this is some hundreds of slots, far past any real routine and
// past the app's own MAX_ROUTINE_ROWS (frontend/src/lib/limits.js).
export const MAX_SHARED_BYTES = 65536;
// A routine name another user is shown, in characters (code points, so an emoji is never cut in
// half). The app's exercise-name field has the same bound.
export const MAX_SHARED_NAME = 80;

/** The routine's name as it leaves the server: text, at most MAX_SHARED_NAME characters. */
export function sharedName(r) {
  const s = text(r.name);
  if (s.length <= MAX_SHARED_NAME) return s;
  // Twice as many UTF-16 units always hold the first MAX_SHARED_NAME code points.
  return Array.from(s.slice(0, MAX_SHARED_NAME * 2)).slice(0, MAX_SHARED_NAME).join('');
}

// The routine's own fields as a recipient gets them, `ex` aside.
function sharedHead(r) {
  const out = pick(r, ROUTINE_FIELDS);
  out.name = sharedName(r);
  if (text(r.emoji)) out.emoji = text(r.emoji); else delete out.emoji;
  return out;
}

/** The routine as a recipient gets it: the listed fields only, on the routine and on each slot. */
export function sharedRoutine(r) {
  const out = sharedHead(r);
  out.ex = sharedSlots(r).map(e => pick(e, SLOT_FIELDS));
  return out;
}

/** The pending preview: the routine's name and how many slots the recipient would get. */
export const sharedPreview = r => ({ name: sharedName(r), exercises: sharedSlots(r).length });

/**
 * The UTF-8 length of JSON.stringify(sharedRoutine(r)), exactly while it is at most `cap`; past
 * `cap` it stops counting and answers some number over it. Nothing is projected ahead of the
 * count: the routine without its slots is serialised once, then `r.ex` is walked one slot at a
 * time, each filtered and picked as sharedRoutine would and serialised on its own, and the walk
 * ends as soon as the total passes the cap. So the slots read on an over-cap routine are the ones
 * that fit in the cap plus one, however many it has. A slot sharedRoutine leaves out adds nothing
 * and is passed over with a type check. Throws what the projection or JSON.stringify throws (a
 * RangeError on a value nested too deep): a caller decides what an unmeasurable routine means.
 */
export function sharedBytes(r, cap = MAX_SHARED_BYTES) {
  // `ex` stays where it is in the key order, empty: the whole is this with the slots, comma
  // separated, between its brackets.
  let n = utf8Length(JSON.stringify({ ...sharedHead(r), ex: [] }));
  const ex = Array.isArray(r.ex) ? r.ex : [];
  for (let i = 0, kept = 0; i < ex.length && n <= cap; i++) {
    const e = ex[i];
    if (!isSharedSlot(e)) continue;
    n += utf8Length(JSON.stringify(pick(e, SLOT_FIELDS))) + (kept++ ? 1 : 0);
  }
  return n;
}

/** Whether `r` is too large to share: its projection is over MAX_SHARED_BYTES. Throws as sharedBytes does. */
export const sharedOverCap = r => sharedBytes(r) > MAX_SHARED_BYTES;
