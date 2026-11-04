// Where code that cannot import the store reads the routines shared with you from (NATG-486):
// lib/mobile.js builds the phone's reminders and nudges, and the store imports it, so the store
// hands its reader over here at start. Null until it has, and wherever no store runs.
let source = () => null
export const setSharedSource = fn => { source = typeof fn === 'function' ? fn : () => null }
export const sharedFor = () => { try { return source() } catch { return null } }
