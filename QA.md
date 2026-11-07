# QA Notes

_Last verified: 2026-11-07 by QA agent (frontend; API notes retained)_

See [CONTRIBUTING.md](CONTRIBUTING.md) for general setup and
[CLAUDE.md](CLAUDE.md) for the architecture and other packages' commands.

## Frontend checks

Verified with Node 22.22.1, npm 9.2.0 and Vitest 5.1.0. The frontend uses
React, Vite and Zustand; component and store tests use happy-dom.

From `frontend/`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npx vitest run src/store/
npx vitest run src/store/shared-routines.reload-newer.test.jsx
node scripts/check-locales.mjs
node scripts/check-source-strings.mjs --strict
npm run build
```

The workflow in `.github/workflows/test.yml` runs the whole suite with coverage,
the web build and locale checks. Its source-string check is report-only; the
command above uses strict mode. There is no separate lint or TypeScript check.

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

For browser checks, use a synthetic plan JSON through Plan's file input. Check
Cancel, Add, malformed JSON, unchanged scheduling when the schedule switch is
off, and persistence after reload. Unknown slot fields must not survive import.

## API checks

From `api/` (Node 22):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The suite uses local fixtures and mock providers; no real Coach credentials are
needed. Neither package defines a separate lint or type-check command.

## Known gaps

`scripts/app-icons.test.mjs` currently has two failures comparing committed icons
with fresh renders on this Linux runtime. They reproduce on the unchanged base;
run `npx vitest run scripts/app-icons.test.mjs` to isolate them. Do not regenerate
icons as part of unrelated frontend changes.

## API checks

Verified with Node 22.22.1 and npm 9.2.0. The API is plain JavaScript on
`node:http`; its suite uses the built-in Node test runner. From `api/`:

```sh
npm ci --omit=optional --no-audit --no-fund
npm test
node --test test/server-reminder.test.js test/server-nudge.test.js
```

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
