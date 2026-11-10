// push-messages.js as server.js sees it under spy-shared.mjs: the real module, with a stderr line
// carrying the title of each reminder and nudge it builds.
import * as real from '../push-messages.js';

const spy = fn => (...a) => { const p = fn(...a); console.error('spy push', JSON.stringify(p.title)); return p; };
export * from '../push-messages.js';
export const dayReminderPush = spy(real.dayReminderPush);
export const nudgePush = spy(real.nudgePush);
