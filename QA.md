# QA Notes

_Last verified: 2026-11-04 by QA agent_

See [CONTRIBUTING.md](CONTRIBUTING.md) for general setup and
[CLAUDE.md](CLAUDE.md) for the architecture and other packages' commands.

## Frontend checks

Verified with Node 22.22.1, npm 9.2.0 and Vitest 4.1.12. The frontend uses
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

## Known gaps

`scripts/app-icons.test.mjs` currently has two failures comparing committed icons
with fresh renders on this Linux runtime. They reproduce on the unchanged base;
run `npx vitest run scripts/app-icons.test.mjs` to isolate them. Do not regenerate
icons as part of unrelated frontend changes.
