# QA Notes

_Last verified: 2026-11-04 by QA agent_

## Stack

Verified on Linux with Node 22.22.1 and npm 9.2.0. The frontend uses React 19.3.1,
Vite 8.3.5, Zustand and Vitest 4.1.12. Component and store tests use happy-dom;
the API uses Node's test runner. There is no separate frontend lint or type-check script.

## Running checks

```bash
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
node scripts/check-locales.mjs
node scripts/check-source-strings.mjs --strict
```

The frontend CI job in `.github/workflows/test.yml` runs Vitest with coverage,
the web build and locale checks; its source-string check is report-only. The
commands above also work without coverage. See that workflow for the other CI jobs.

The API sharing tests use isolated services and synthetic accounts:

```bash
cd api
npm ci --omit=optional --no-audit --no-fund
node --test test/server-shares.test.js test/server-shares-projection.test.js
```

## How to test shared routines

```bash
cd frontend
npx vitest run src/store/shared-routines.mobile.test.jsx src/store/shared-routines.test.jsx src/store/useStore.mobile-durable.test.jsx src/views/RoutineEdit.sharing-guard.test.jsx src/sheets.add-to-routine-guard.test.jsx src/sheets.finish-keep-routine-shared.test.jsx src/lib/shared-routines.readers.test.js
```

The share slice is separate from `S`: localStorage key `gym_shared_v1`, native file
`opengym-shared.json`. Own state stores only `shared:<id>` pointers. Store tests cover
revision-etag refresh, account scoping and schedule cleanup. The phone tests stub the
native read boundary and API; they verify store recovery and the native write helper,
and do not replace physical iOS/Android verification.

For UI checks, `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort` serves the app.
Chromium checks with synthetic API fixtures covered Shared, the read-only view, weekday
assignment, offline notices, backup warnings and workout refusal/disabled states at
320, 390, 768 and 1440 px. Exercise media requests can be blocked for layout checks.

## Known gaps

- The app-icon redraw checks can fail on this Linux environment (tracked separately).
  Preserve the failing output; do not regenerate icons as part of QA.
- Shared dialogs inherit the existing focus-management gap tracked in the backlog:
  the Remove confirmation leaves focus on its opener, rather than moving to Cancel.
- Native notifications, physical phone storage eviction and watch interaction require
  device testing. Browser viewport emulation does not verify them.
