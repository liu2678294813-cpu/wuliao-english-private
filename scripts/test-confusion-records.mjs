import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfusion, confusionMatches } from '../public/vocabulary/confusion-records.js';
import { createScreeningController } from '../public/vocabulary/screening-controller.js';
import { withMemoryProgress } from '../public/vocabulary/memory-record.js';

const input = { username: 'alice', eventId: 'one', source: 'review',
  word: { wordId: 'import:a', english: 'accept', chinese: '接受' },
  choice: { wordId: 'unknown:except', english: 'except', chinese: '除外', correct: false } };
test('explicit distractor snapshots preserve imported/unknown identity and meaning', () => {
  const row = makeConfusion(input);
  assert.equal(row.sourceWordId, 'unknown:except');
  assert.equal(row.correctWordId, 'import:a');
  assert.equal(row.sourceWord, 'except');
  assert.equal(row.round, undefined);
  assert.equal(confusionMatches(row), true);
  assert.equal(confusionMatches(row, 'review'), true);
  assert.equal(confusionMatches(row, '1'), false);
});
test('correct, skip, unsupported and handwriting errors create no confusion', () => {
  for (const choice of [null, { chinese: '不会' }, { ...input.choice, correct: true },
    { ...input.choice, isCorrect: true }, { ...input.choice, isSkip: true }]) assert.equal(makeConfusion({ ...input, choice }), null);
});
test('legacy rows remain readable and screen rounds exclude review records', () => {
  assert.equal(confusionMatches({ round: 1 }, '1'), true);
  assert.equal(confusionMatches({ round: 1, source: 'review' }, '1'), false);
  assert.equal(confusionMatches({}), true);
});
test('normal progress changes preserve pending events and original review dates', () => {
  const previous = { memoryKey: 'alice:original:word', username: 'alice', listKey: 'original',
    maskedDates: ['2026-09-01'], pendingConfusions: [makeConfusion(input)] };
  const next = withMemoryProgress(previous, 'word', 0, { username: 'alice', listKey: 'original' });
  assert.deepEqual(next.pendingConfusions, previous.pendingConfusions);
  assert.deepEqual(next.maskedDates, previous.maskedDates);
});
test('failed screening transaction retries the same event and next question gets a new event', async () => {
  let fail = true;
  const events = [];
  const controller = createScreeningController({ skipId: 'skip',
    load: async () => ({ username: 'alice', round: 1, listId: 4, startedAt: 100, sessionKey: 'alice:4:1',
      currentIndex: 0, correctIds: [], wrongIds: [], sourceWordIds: ['word-a', 'word-b'] }),
    word: async (wordId) => ({ wordId, english: wordId, chinese: '正确' }),
    options: async () => [{ id: 'yes', isCorrect: true, chinese: '正确' },
      { id: 'no', chinese: '错误', sourceWord: 'except', sourceWordId: 'word-other' }],
    save: async (session, record, confusion) => { events.push({ record, confusion }); if (fail) { fail = false; throw new Error('abort'); } },
    error: () => {} }, () => {}, { clearTimeout, setTimeout: (cb) => setTimeout(cb, 0), performance });
  await controller.start('alice', 1, 4);
  await assert.rejects(controller.answer('no'), /abort/);
  await controller.answer('no');
  await controller.answer('no');
  assert.equal(events[0].confusion.eventId, events[1].confusion.eventId);
  assert.notEqual(events[1].confusion.eventId, events[2].confusion.eventId);
  assert.deepEqual(events[0].record.confusion, events[0].confusion);
  assert.equal(events[2].confusion.correctEnglish, 'word-b');
});
