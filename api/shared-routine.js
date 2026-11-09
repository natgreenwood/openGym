// What of a sharer's routine leaves the server for a recipient (routine sharing, NATG-483), and
// the content hash a recipient's client compares it by. Kept out of server.js so the frontend's
// parity test can load it: the field lists mirror what the plan export keeps
// (frontend/src/lib/plan-share.js buildPlanBundle and cleanEx), and
// frontend/src/lib/shared-routine-parity.test.js fails when cleanEx gains a field this list
// lacks. An allowlist, not a blocklist: a slot field added later stays on the server until it is
// listed here on purpose.
//
// The server copies the listed fields as they are stored. It does not normalise them the way
// cleanEx does (a pyramid's length, an incline's clamp, a mode the catalogue implies): the
// recipient's client runs the plan import's normalisation on every incoming routine. What the
// server does check is type, where a value is the sharer's word and another user's screen or
// push text depends on it (SEC-01): the routine's `name` and `emoji` are text or empty, and a
// slot whose `id` is not a string is left out, since nothing can resolve it.
//
// And size (NATG-494): the server builds, hashes and sends this projection for other people, so
// what one sharer can make it cost them is capped. The name is bounded wherever it leaves the
// server (sharedName), and a routine whose projection is over MAX_SHARED_BYTES is not shared at
// all: POST /api/shares refuses it and every read shows it as `unavailable: 'too-large'`.
import crypto from 'node:crypto';

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
/** The slots of `r` a recipient gets, before their fields are picked: entries with a string id. */
export const sharedSlots = r => (Array.isArray(r.ex) ? r.ex : []).filter(e => isEntry(e) && typeof e.id === 'string');
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

/** The routine as a recipient gets it: the listed fields only, on the routine and on each slot. */
export function sharedRoutine(r) {
  const out = pick(r, ROUTINE_FIELDS);
  out.name = sharedName(r);
  if (text(r.emoji)) out.emoji = text(r.emoji); else delete out.emoji;
  out.ex = sharedSlots(r).map(e => pick(e, SLOT_FIELDS));
  return out;
}

/** The pending preview: the routine's name and how many slots the recipient would get. */
export const sharedPreview = r => ({ name: sharedName(r), exercises: sharedSlots(r).length });

/**
 * The UTF-8 length of JSON.stringify(sharedRoutine(r)), exactly while it is at most `cap`; past
 * `cap` it stops counting and answers some number over it. The routine without its slots is
 * serialised once, then each slot on its own, so a routine of thousands of slots costs the slots
 * up to the cap, not all of them. Throws what JSON.stringify throws (a RangeError on a value
 * nested too deep): a caller decides what an unmeasurable routine means.
 */
export function sharedBytes(r, cap = MAX_SHARED_BYTES) {
  const out = sharedRoutine(r);
  // `ex` stays where it is in the key order, empty: the whole is this with the slots, comma
  // separated, between its brackets.
  let n = Buffer.byteLength(JSON.stringify({ ...out, ex: [] }));
  for (let i = 0; i < out.ex.length && n <= cap; i++) n += Buffer.byteLength(JSON.stringify(out.ex[i])) + (i ? 1 : 0);
  return n;
}

/** Whether `r` is too large to share: its projection is over MAX_SHARED_BYTES. Throws as sharedBytes does. */
export const sharedOverCap = r => sharedBytes(r) > MAX_SHARED_BYTES;

// JSON with every object's keys sorted, all the way down, so two copies of the same content hash
// the same whatever order a client wrote the keys in.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

/** 16 hex characters of SHA-256 over the canonical JSON of `v`: a version tag, equality only. */
export const contentHash = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 16);
