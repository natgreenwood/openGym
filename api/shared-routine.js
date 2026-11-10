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
//
// The projection and its measure live in shared-measure.js, which the app imports as well, and
// are re-exported here unchanged; this module adds the content hash, which needs node:crypto.
import crypto from 'node:crypto';

export * from './shared-measure.js';

// JSON with every object's keys sorted, all the way down, so two copies of the same content hash
// the same whatever order a client wrote the keys in.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

/** 16 hex characters of SHA-256 over the canonical JSON of `v`: a version tag, equality only. */
export const contentHash = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 16);
