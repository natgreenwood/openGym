# QA Notes

_Last verified by QA agent: 2026-11-09 (frontend); 2026-11-06 (API)_

See [CONTRIBUTING.md](CONTRIBUTING.md) for general setup and
[CLAUDE.md](CLAUDE.md) for the architecture and other packages' commands.

## Frontend checks

Verified with Node 22.22.1, npm 9.2.0 and Vitest 5.1.0. The frontend uses
React, Vite and Zustand; component and store tests use happy-dom.

From `frontend/`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test -- --maxWorkers=2
npx vitest run src/store/ --maxWorkers=2
npx vitest run src/store/shared-routines.reload-newer.test.jsx
node scripts/check-locales.mjs
node scripts/check-source-strings.mjs --strict
npm run build
```

The workflow in `.github/workflows/test.yml` runs the whole suite with coverage,
the web build and locale checks. Its source-string check is report-only; the
command above uses strict mode. There is no separate lint or TypeScript check.

Check test-order isolation with the whole suite, changing the seed between runs:

```sh
npx vitest run --sequence.shuffle --sequence.seed=7
```

Vitest's shuffle seed controls test order, not fast-check's property inputs; see
Known gaps for the plates property test.

## Swipe-back preview tests

From `frontend/`, on Linux with CPU 0 available:

```sh
./node_modules/.bin/vitest --clearCache
taskset -c 0 ./node_modules/.bin/vitest run src/App.swipe-preview.test.jsx --reporter=verbose --maxWorkers=1
```

For the contention reproduction, run eight competing processes with
`taskset -c 0 python3 -c 'while True: pass'`, sharing that CPU with Vitest.
Clear the cache before each run and stop the competing processes afterward. Vitest's persistent
transform cache can make the original lazy-import timeout disappear, so warm
runs cannot establish that the preload fixes it. The four cases cover preview
route, scroll position, inert/hidden attributes, element identity, cancellation
and a back navigation that lands elsewhere. No account or server is needed.

## Cross-tab account ownership

From `frontend/`:

```sh
npx vitest run src/store/useStore.tabs-owner.test.jsx --no-fsModuleCache
```

The harness uses fresh store imports sharing localStorage, a mock API, held storage
events and fake timers. It covers owner changes before edits and before pending
or resumed sends, including same-account sign-in. It does not exercise real browser
session cookies or storage-event scheduling. No credentials or running server are
needed.

- `accounts()` / `hold()` control late responses, including a boot 401 after
  another tab changes accounts and a 401 with the owner unchanged.
- `act()` identifies the writing tab; a tab's `busy` counter delays its storage
  callbacks until `pump()` can deliver them.

For mutation checks that transform guards in memory, disable `fsModuleCache`:
changing only a plugin's environment options can reuse a previous transformed module.
When changing the helpers, compare test names and counts against the base, then
compare failing names after removing the same owner guards from each version.
Cover the `doPush` send guard alone, together with each of the 409, `pushAgain`
and debounce guards, and each of those three guards alone. Also check the
post-GET `pullState` guard, because held GET answers use the same helper.

## Account sync and sign-out

From `frontend/`, check account ownership, reset propagation, backup replacement
and revision-conflict retries together:

```sh
npx vitest run src/store/useStore.tabs-owner.test.jsx src/store/useStore.reset-sync.test.jsx src/store/useStore.import-check.test.jsx src/store/useStore.import-restore.test.jsx --maxWorkers=2
```

Then the store with the adjacent leave-server UI:

```sh
npx vitest run src/store/ src/components/ServerSync.leave.test.jsx src/components/ServerSync.media.test.jsx src/components/ServerSync.retry-owner.test.jsx src/views/Settings.server-sync.test.jsx --reporter=dot
```

These tests use synthetic localStorage profiles and mocked API responses. The
tabs-owner suite checks outgoing `baseRev` values and the resulting document
with a revision-aware mock server; it does not exercise real device-link
authentication or browser storage-event scheduling.

- `useStore.sync-status.test.jsx` covers clean sign-out, owed marks, debounced
  and in-flight pushes, failed uploads, forced stashes and logout failures.
- `useStore.tabs-join.test.jsx` and `useStore.tabs-owner.test.jsx` cover
  saved-tab changes and account switches.
- `useStore.hold-signout.test.jsx` and `useStore.media.test.jsx` cover adoption
  holds and pending media.
- `ServerSync.retry-owner.test.jsx` checks the initiating account through a retry
  after its sheet unmounts and a forced attempt before the owner event arrives,
  using real stores and the UI account-change subscriber.

In a browser with a synthetic profile, use Settings → Account → Sign out and
Sign out everywhere. A clean copy sends only the corresponding logout POST;
an edited copy sends `PUT /api/data` before logout. Both clear memory and the
saved workout list. A failed PUT keeps the account and workouts locally and
sends no logout. Browser checks with intercepted API responses cannot establish
server revision changes or delivery to other devices.

For cancellation, hold the sign-out's pull or the owed sheet's retry GET, sign
another synthetic account into a second tab, then release the response. Check
that no logout is sent, the new owner stays signed in, the sheet closes, and the
cancellation toast names that account without leaving Settings. Also test a new,
deliberate sign-out after the tab follows the new account.

## Shared routines

- `src/store/shared-routines.reload-newer.test.jsx` holds controlled GET/DELETE
  orderings for Accept, Decline, Remove, revokes and account changes.
  It mocks the API and UI toast; it cannot verify the actual toast component or navigation.
- `src/views/Plan.shared-tab.test.jsx` covers pending cards, confirmations,
  offline controls and accessible labels. `src/views/SharedRoutineView.test.jsx`
  covers the read-only routine and Remove confirmation.
- Browser checks should use synthetic accounts and routines. Exercise Accept,
  Decline and Remove with cancel/confirm, offline answers, retry after an error,
  and owner revocation. Verify schedule cleanup and preserved workout history.
  Control the network so a GET lands after DELETE applies but before its response.

## Plan import and Coach-created plans

From `frontend/`, run the slot allowlist, export/import round-trip, API parity,
Coach validation/application and shared-routine regression tests together:

```sh
npx vitest run src/lib/plan-share.test.js src/lib/shared-routine-parity.test.js src/lib/coach.test.js src/lib/shared-routines.test.js src/lib/shared-routines.boundary.test.js src/sheets.save-as-routine-shared.test.jsx --maxWorkers=2
```

For browser checks, use a synthetic plan JSON through Plan's file input. Include
weekday assignments in its `week` block to show the schedule switch. Check Cancel,
Add, malformed JSON, unchanged scheduling with the switch off, replacement
assignments with it on, and persistence after reload. Unknown slot fields must
not survive import.

## Import notice contrast

From `frontend/`, run the notice, contrast and adjacent plan/sharing checks:

```sh
npx vitest run src/a11y-contrast-transparency.test.js src/sheets.import-notices.test.jsx src/views/SharedRoutineView.test.jsx src/views/Plan.shared-tab.test.jsx src/lib/plan-share.test.js --maxWorkers=2
```

The contrast test resolves CSS tokens; also measure computed text colours against
the notice's rendered background in a browser. Check light, dark and light with
`prefers-contrast: more`, including 320px width. Both title and body must reach
4.5:1. Notice body text uses `--label`.

Upload synthetic plan JSON through Plan's file input with zero, one and two unknown
exercise IDs alongside a valid exercise. Only the latter two show a titled warning;
Add retains existing routines and excludes unknown exercises. For workout CSV,
check converted, mixed and matching units: conversion notices have an info icon
and body only. Check Hevy with intercepted HTTP and synthetic responses, in kg
and lb; no live account or real API key is needed. Include the Shared tab's offline
notice and an unavailable shared routine when changing the shared CSS. Wait for
the boot overlay and sheet animations to finish before taking screenshots.

## Count limits and sharing notices

From `frontend/`, run the count caps and adjacent import/share/watch boundaries:

```sh
npx vitest run src/sheets.config-count-caps.test.jsx src/components/ui.test.jsx src/lib/plan-share.test.js src/lib/shared-routines.limits.test.js src/lib/shared-routines.boundary.test.js src/lib/shared-routine-parity.test.js src/lib/watch-sync.test.js src/sheets.plan-import-toast.test.jsx src/components/ShareRoutineSheet.test.jsx --maxWorkers=2
```

In a browser, check click, hold, keyboard activation and typing above the cap
followed directly by Save. Sets (reps, time and Sets from) and cardio Intervals
cap at 50, Drops at 10, Rest-pause reps at 1,000 and Sets up to at 10. The hint
has `role="status"`; at the cap, + is `aria-disabled` but retains keyboard focus.
Check the rest-pause hint at 320px as well as wider viewports.

Import synthetic counts of 80 sets, 25 drops and 5,000 rest-pause reps: the
preview reports lowered counts, and Add stores 50, 10 and 1,000. At-limit
imports show no reduction notice. Export also caps older over-limit data.
`capped` counts exercises, not fields; it excludes `setsMax` and dropped slots.
The sharing notice informs without blocking Share; verify both over-limit and
within-limit routines with mocked recipients. These checks do not establish
live-server delivery or native watch behavior.

## Backup media

From `frontend/`:

```sh
npx vitest run src/lib/backup-media.test.js src/views/Settings.import-media.test.jsx src/lib/media-store.test.js src/lib/media-sync.test.js
```

The helper tests read real ZIPs and check media validation, rollback, current
references, editor holds, removal during import and continuation after per-file
storage errors. The Settings test uses real media helpers and a memory backend,
with the file read and account store mocked.

For browser verification, use synthetic photos in a real ZIP through Settings
→ Data & backup → Import backup. Seed one synced and one pending photo already
on the device, plus a new photo in the backup. Schedule an account change after
the first write: the import must be refused, the new photo removed, the existing
flags restored, and no success message shown. Also verify an accepted import
keeps all photos pending. Inspect IndexedDB again after reload; an in-memory
check alone cannot establish persistence. These flows can run locally without
an account or production credentials.

Also schedule sign-out's `retainOnly` cleanup just before an existing photo's
write, for both synced and pending photos. A refused import must remove the
recreated bytes. Inject a backend patch failure restoring the first of two synced
photos: rollback must continue, restore the second and avoid a UI rejection or
success message. The failed record itself can remain pending after reload;
rollback is best effort. Verify backend flags as well as the in-memory index.
When wrapping `media.put` to control timing, return its original result: rollback
uses that previous-record snapshot to classify each write.

## Weight-rate timezone checks

From `frontend/`, run each timezone in a fresh process so module-level fixture
dates use that zone:

```sh
TZ=Pacific/Auckland npx vitest run src/lib/bodyweight-rate.test.js
TZ=UTC npx vitest run src/lib/bodyweight-rate.test.js
TZ=America/Los_Angeles npx vitest run src/lib/bodyweight-rate.test.js
```

For adjacent bodyweight, display, unit and date-format behavior at UTC+14:

```sh
TZ=Pacific/Kiritimati npx vitest run src/lib/bodyweight-rate.test.js src/lib/bodyweight.test.js src/components/WeightRate.test.jsx src/views/Stats.bodyweight.test.jsx src/lib/units.test.js src/lib/format.helpers.test.js --maxWorkers=2
```

Date-only fixtures must use local calendar dates: start at noon, subtract days
with `setDate`, then format with `isoOf`. `toISOString()` uses UTC and can move
the fixture to the previous date; subtracting 86400000 also crosses DST poorly.

## Sheets and media focus

From `frontend/`:

```sh
npx vitest run src/components/Modals.test.jsx src/sheets.workout-media.test.jsx
```

The modal focus cases use happy-dom because linkedom does not implement focus.
Keep the global-window restoration check when editing that block. The media
suite also covers focus returning from a viewer to an underlying sheet.

In a browser, use keyboard Tab/Enter to open a sheet and a centre dialog above
it. Check container focus without a ring, visible rings on controls, and Escape
restoring the lower opener, then the page opener. Repeat with a removed,
disabled or hidden lower opener and with two sheets opened in one update:
closing the top must focus the surviving dialog container. Check autoFocus
search inputs retain focus and closing a lower sheet leaves the top alone.

Viewer checks: Close takes focus, Tab/Shift+Tab stay inside, and closing returns
to the underlying thumbnail. Check `#app` gains/removes `inert` and `aria-hidden`
in both boot and ready branches. Keyboard flows were exercised in Chromium at
1280 px and 390 px widths; screen-reader announcements and native shells still
need device testing. A page text field intentionally does not regain focus on
close, to avoid reopening the keyboard.

## Apple Watch and iPhone widgets

From `frontend/`, run the snapshot, event, settings and widget regressions:

```sh
npx vitest run src/lib/watch-sync*.test.js src/lib/watch-settings.test.js src/lib/widgets.test.js
```

These tests use local fixtures and a mocked native bridge; no credentials or
paired device are required. They cover shared-session construction, routine and
exercise text boundaries, superset IDs, ready sessions, event application and
widget snapshots. For a direct module probe in Node, load these modules through
Vite's `createServer({ server: { middlewareMode: true } }).ssrLoadModule(...)`;
their imports depend on Vite transforms. Close the server in `finally`.

Measure the UTF-8 bytes of serialized snapshots against `SNAPSHOT_MAX_BYTES`,
and compare the active workout before and after `fitSnapshot`. Per-field text
limits do not guarantee the total budget for many-entry active workouts, even
with accepted shared routines. Serialization tests cannot establish native
delivery: pairing, locked-phone operation and transport failures require an
iPhone and Apple Watch.

## Known gaps

`scripts/app-icons.test.mjs` currently has two failures comparing committed icons
with fresh renders on this Linux runtime. They reproduce on the unchanged base;
run `npx vitest run scripts/app-icons.test.mjs` to isolate them. Do not regenerate
icons as part of unrelated frontend changes.

`src/lib/plates.property.test.js` can independently fail its fewest-plates
property: `plateStack` sometimes chooses more plates than necessary. Inspect
the failing test rather than treating every shuffled-run failure as an order leak.

`backup-media.test.js` builds 1,999 media entries in its ZIP entry-limit test.
It can exceed Vitest's default five-second timeout during concurrent heavy
suites. The focused backup-media command passed on rerun after the frontend
suite finished; record any timeout separately from rollback assertion failures.

The MCP rate-limit test in `mcp/test/write-tools.test.js` generates local dates
by subtracting elapsed 24-hour periods. Late in the day after the autumn DST
change, Europe/London can produce a duplicate date and fail the test. This
reproduces on unchanged main. From `mcp/`, `TZ=UTC npm test` passes on the same
runtime; retain the local-time failure as a fixture defect rather than treating
the UTC run as a fix.

## API checks

Verified with Node 22.22.1 and npm 9.2.0. The API is plain JavaScript on
`node:http`; its suite uses the built-in Node test runner. From `api/`:

```sh
npm ci --omit=optional --no-audit --no-fund
npm test
node --test test/server-reminder.test.js test/server-nudge.test.js
```

The suite uses local fixtures and mock providers; no real Coach credentials are
needed. The install command matches CI and omits the optional Coach Agent SDK.

There is no API build, lint or type-check script. For the API job's coverage and
reporter options, see `.github/workflows/test.yml`. Its other checks, from the
repository root (install the root dependencies first):

```sh
npm ci --omit=optional --no-audit --no-fund
node scripts/build-coach-assets.mjs --check
node scripts/build-api-docs.mjs --check
node api/scripts/check-core-loadable.mjs
```

The reminder and nudge integration tests spawn the real server with `PORT=0`,
an isolated temporary `DATA_DIR`, and a shortened `REMINDER_TICK_MS`. Their
fixtures and cleanup live in `api/test/`; no account or push provider is needed.
`boundPort()` in `api/test/helpers.mjs` waits for the bound port's boot line.

Payload-failure tests opt into `--import ./test/fail-push.mjs` and toggle the
file named by `PUSH_FAULT_FILE`. They check unchanged database contents and
mtime, retry after recovery, and one failure log across repeated ticks. The
local-date rollover of failure logging is not automated: `userNow()` uses
`new Date()`, while `test/fake-clock.mjs` only patches `Date.now()`. Review the
date comparison in `payloadFailed()` when changing this behavior.

`push-messages.test.js` covers routine-field normalization and language
fallbacks. `server-bad-input.test.js` exercises malformed stored language on
an actual rest-timer callback; `server-push-status.test.js` covers timer
routing, cancellation and throttling. These tests establish send attempts,
not delivery to a device.

### Origin-hint tests

The origin-hint integration tests spawn the server with an isolated temporary
`DATA_DIR`, synthetic passkeys, `PORT=0`, `ORIGIN` and `RP_ID`. From `api/`:

```sh
node --test test/server-origin-hint.test.js
node --test --experimental-test-coverage test/server-origin-hint.test.js
```

For log-wait changes, exercise a server-only 17 s preload delay, an exception
before test 4's request, and a missing log line. Check that the delayed boot
passes within the existing 20 s boot limit, early failures report once without
`unhandledRejection` or activity-after-test warnings, and missing lines still
fail normally. Test 4 must also fail if `logLine` is mutated to read only the
caller's buffered output: this confirms its early-listener coverage. Use
disposable copies for fault injection; do not alter the reviewed branch.
