/* A push payload build that fails on demand, for a server.js spawned in a child. Load it ahead of
 * the server with `node --import ./test/fail-push.mjs server.js` and PUSH_FAULT_FILE in its env.
 *
 * server.js's import of ./push-messages.js is resolved to push-messages.faulty.mjs instead: the
 * real builders, except that dayReminderPush and nudgePush throw while the file PUSH_FAULT_FILE
 * names exists. The test creates and removes that file to make the build fail and then succeed
 * inside one process. No production code knows about it. */
import { register } from 'node:module';
register('./fail-push-hooks.mjs', import.meta.url);
