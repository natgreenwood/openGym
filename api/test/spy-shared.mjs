/* Watches routine sharing's costly steps in a server.js spawned in a child, for the NATG-494 tests.
 * Load it ahead of the server with `node --import ./test/spy-shared.mjs server.js`.
 *
 * server.js's imports of ./shared-routine.js and ./push-messages.js are resolved to the .spy.mjs
 * modules beside this file: the real ones, except that each projection, hash and measure the
 * server asks for, and each reminder or nudge title it builds, is written to stderr as one
 * `spy …` line, and the measure throws while the file SHARE_FAULT_FILE names exists. The test
 * counts the lines. No production code knows about it. */
import { register } from 'node:module';
register('./spy-shared-hooks.mjs', import.meta.url);
