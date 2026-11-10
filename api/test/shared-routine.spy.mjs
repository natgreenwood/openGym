// shared-routine.js as server.js sees it under spy-shared.mjs: the real module, with a stderr line
// for each projection, hash and measure server.js asks for, and a measure that throws while
// SHARE_FAULT_FILE exists. The real sharedBytes builds its own projection, which is not counted:
// `spy project` is a projection the server keeps.
import fs from 'node:fs';
import * as real from '../shared-routine.js';

export * from '../shared-routine.js';
export const sharedRoutine = r => { console.error('spy project', real.text(r?.id)); return real.sharedRoutine(r); };
export const contentHash = v => { console.error('spy hash', 'preview' in v ? 'preview' : 'routine'); return real.contentHash(v); };
export const sharedOverCap = r => {
  console.error('spy measure', real.text(r?.id));
  if (process.env.SHARE_FAULT_FILE && fs.existsSync(process.env.SHARE_FAULT_FILE)) throw new RangeError('measure fault');
  return real.sharedOverCap(r);
};
