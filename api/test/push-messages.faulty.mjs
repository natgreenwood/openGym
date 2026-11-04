// push-messages.js as server.js sees it under fail-push.mjs: the reminder and nudge builders throw
// while PUSH_FAULT_FILE exists, and everything else is the real module.
import fs from 'node:fs';
import * as real from '../push-messages.js';

const faulty = fn => (...a) => {
  if (process.env.PUSH_FAULT_FILE && fs.existsSync(process.env.PUSH_FAULT_FILE)) throw new Error('payload fault');
  return fn(...a);
};
export const dayReminderPush = faulty(real.dayReminderPush);
export const nudgePush = faulty(real.nudgePush);
export const { restTimerPush, testPush, routineEmoji } = real;
