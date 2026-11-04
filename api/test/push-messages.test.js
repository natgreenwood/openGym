import test from 'node:test';
import assert from 'node:assert/strict';
import { dayReminderPush, nudgePush, restTimerPush, routineEmoji, testPush } from '../push-messages.js';

test('localizes every server-generated notification in pt-BR', () => {
  assert.deepEqual(restTimerPush('pt-BR'), {
    title: 'Descanso terminado 💪',
    body: 'Hora da próxima série.',
    tag: 'rest-timer',
  });
  assert.deepEqual(testPush('pt-BR'), {
    title: 'openGym',
    body: 'Notificação de teste ✅ É assim que os alertas aparecem.',
    tag: 'test',
  });
  assert.deepEqual(dayReminderPush('pt-BR', { name: 'Treino A', emoji: '💪' }), {
    title: '💪 Treino A hoje',
    body: 'Está no seu plano. Bora treinar 💪',
    tag: 'day-reminder',
  });
});

test('keeps the existing English copy as the fallback', () => {
  assert.deepEqual(restTimerPush('fr'), restTimerPush('en'));
  assert.equal(dayReminderPush('unknown', null).title, 'Workout planned today');
  assert.equal(testPush(undefined).body, 'Test notification ✅ This is what alerts look like.');
});

// Routines stopped storing a literal emoji when the glyph picker landed: `emoji` now holds an
// icon key the app renders as an SVG. A notification has no SVG, so before this the reminder
// read "dumbbell Push today" — the key's own name, on the lock screen.
test('renders a routine glyph key as an emoji, never as its name', () => {
  assert.equal(routineEmoji('dumbbell'), '🏋️');
  assert.equal(routineEmoji('figureRun'), '🏃');
  assert.equal(routineEmoji('legs'), '🦵');
  assert.equal(
    dayReminderPush('pt-BR', { name: 'Costas e Bíceps', emoji: 'dumbbell' }).title,
    '🏋️ Costas e Bíceps hoje',
  );
});

test('leaves a literal emoji alone and falls back for anything else', () => {
  assert.equal(routineEmoji('💪'), '💪');
  assert.equal(routineEmoji('🏋️‍♀️'), '🏋️‍♀️');
  // An icon key the picker no longer offers is still ASCII, so it falls back to the default
  // rather than reaching the phone as a word.
  assert.equal(routineEmoji('trophy'), '🏋️');
  assert.equal(routineEmoji(''), '🏋️');
  assert.equal(routineEmoji(undefined), '🏋️');
});

// PUT /api/data stores an own routine's `name` and `emoji` as sent, and both are interpolated
// into the push. An object whose `toString` is not a function makes that interpolation throw, so
// the push could never be built for that user (NATG-515). They go through the same text() rule
// the shared projection uses: a number is its digits, anything else that is not text falls back.
const sendable = p => {
  assert.equal(typeof p.title, 'string');
  assert.equal(typeof p.body, 'string');
  assert.ok(p.title.length > 0 && p.body.length > 0);
  assert.doesNotMatch(p.title + p.body, /undefined|\[object |function /);
};
const iso = '2026-09-07';

test('an own routine whose name or emoji is not text still builds a sendable reminder and nudge', () => {
  for (const bad of [{ toString: 1 }, [{ toString: 1 }], { a: 1 }, ['x'], true, null]) {
    const label = JSON.stringify(bad);
    const day = dayReminderPush('en', { name: bad, emoji: '💪' });
    sendable(day);
    assert.equal(day.title, 'Workout planned today', label);
    assert.equal(dayReminderPush('en', { name: 'Legs', emoji: bad }).title, '🏋️ Legs today', label);
    sendable(dayReminderPush('en', { name: bad, emoji: bad }));
    const nudge = nudgePush('en', 'friendly', { name: bad }, iso);
    sendable(nudge);
    assert.deepEqual(nudge, nudgePush('en', 'friendly', { name: 'openGym' }, iso), label);
    assert.equal(routineEmoji(bad), '🏋️', label);
  }
});

test('a numeric routine name renders as its digits; an empty one falls back', () => {
  assert.equal(dayReminderPush('en', { name: 5, emoji: '💪' }).title, '💪 5 today');
  assert.deepEqual(nudgePush('en', 'friendly', { name: 5 }, iso), nudgePush('en', 'friendly', { name: '5' }, iso));
  assert.equal(dayReminderPush('en', { name: '', emoji: '💪' }).title, 'Workout planned today');
  assert.deepEqual(nudgePush('en', 'friendly', { name: '' }, iso), nudgePush('en', 'friendly', null, iso));
});

// `lang` is stored as the client sent it too, and a plain property lookup finds Object's own
// prototype keys: `constructor` resolved to Object, so the nudge threw on `copy.lines` and the
// reminder read "undefined" where its copy should be.
test('a lang that names an Object prototype key falls back to English', () => {
  for (const lang of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const day = dayReminderPush(lang, { name: 'Legs', emoji: '💪' });
    sendable(day);
    assert.deepEqual(day, dayReminderPush('en', { name: 'Legs', emoji: '💪' }), lang);
    const nudge = nudgePush(lang, 'friendly', { name: 'Legs' }, iso);
    sendable(nudge);
    assert.deepEqual(nudge, nudgePush('en', 'friendly', { name: 'Legs' }, iso), lang);
    assert.deepEqual(restTimerPush(lang), restTimerPush('en'), lang);
    assert.deepEqual(testPush(lang), testPush('en'), lang);
  }
});

test('an emoji that names an Object prototype key falls back to the default glyph', () => {
  for (const key of ['constructor', 'toString', 'valueOf']) assert.equal(routineEmoji(key), '🏋️', key);
});
