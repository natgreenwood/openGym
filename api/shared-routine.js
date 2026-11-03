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
// The same rule as server.js `text()`: String() is not safe on parsed JSON, `{"toString":1}`
// makes it throw. A string stays, a number becomes one, anything else is empty.
export const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** The slots of `r` a recipient gets, before their fields are picked: entries with a string id. */
export const sharedSlots = r => (Array.isArray(r.ex) ? r.ex : []).filter(e => isEntry(e) && typeof e.id === 'string');
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (Object.hasOwn(o, k) && o[k] !== undefined) out[k] = o[k];
  return out;
};

/** The routine as a recipient gets it: the listed fields only, on the routine and on each slot. */
export function sharedRoutine(r) {
  const out = pick(r, ROUTINE_FIELDS);
  out.name = text(r.name);
  if (text(r.emoji)) out.emoji = text(r.emoji); else delete out.emoji;
  out.ex = sharedSlots(r).map(e => pick(e, SLOT_FIELDS));
  return out;
}

/** The pending preview: the routine's name and how many slots the recipient would get. */
export const sharedPreview = r => ({ name: text(r.name), exercises: sharedSlots(r).length });

// JSON with every object's keys sorted, all the way down, so two copies of the same content hash
// the same whatever order a client wrote the keys in.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

/** 16 hex characters of SHA-256 over the canonical JSON of `v`: a version tag, equality only. */
export const contentHash = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 16);
