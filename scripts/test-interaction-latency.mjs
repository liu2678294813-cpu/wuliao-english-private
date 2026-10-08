import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreeningController } from '../public/vocabulary/screening-controller.js';
import { createWordSaveQueue } from '../public/vocabulary/word-save-queue.js';
import { eraseAnnotationsInPolygon, pointInPolygon } from '../src/annotationTools.js';
import { createInkSnapshotSerializer } from '../src/ink/inkSnapshot.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const frames = [], errors = [], writes = [];
  const api = { skipId: 'skip',
    load: async (username, round, listId) => ({ username, round, listId, sessionKey: `${username}:${listId}:${round}`,
      currentIndex: 0, correctIds: [], wrongIds: [], sourceWordIds: Array.from({ length: 105 }, (_, i) => `word-${i}`) }),
    word: async (id) => ({ english: id, chinese: `中文-${id}` }),
    options: async (id) => [{ id: 'yes', isCorrect: true, chinese: `中文-${id}` }, { id: 'no', chinese: `错误-${id}` }],
    save: async (session, record) => { writes.push({ session, record }); }, error: (...args) => errors.push(args), ...overrides };
  const controller = createScreeningController(api, (state) => frames.push(state));
  return { controller, frames, writes, errors };
}
test('100 questions: synchronous feedback, duplicate lock, atomic question snapshots', async () => {
  const { controller, frames, writes } = fixture(); await controller.start('test', 1, 5);
  for (let i = 0; i < 100; i++) {
    const work = controller.answer('yes');
    assert.equal(controller.getState().answered, true);
    assert.equal(controller.answer('yes'), work);
    await work;
  }
  assert.equal(writes.length, 100);
  assert.equal(controller.getState().currentIndex, 100);
  for (const frame of frames.filter((frame) => frame.currentEnglish)) {
    assert.equal(frame.options[0].chinese, `中文-${frame.currentEnglish}`);
    assert.equal(frame.currentEnglish, `word-${frame.currentIndex}`);
    assert.ok(frame.questionId);
  }
});
test('slow save displays feedback immediately; failure holds question and retry commits once', async () => {
  let fail = true; const gate = deferred();
  const { controller } = fixture({ save: async () => { if (fail) { await gate.promise; throw Error('disk full'); } } });
  await controller.start('test', 1, 5);
  const work = controller.answer('yes');
  assert.equal(controller.getState().optionStates.yes, 'correct');
  assert.equal(controller.getState().currentIndex, 0);
  gate.resolve(); await assert.rejects(work, /disk full/);
  assert.equal(controller.getState().answered, false);
  fail = false; await controller.answer('yes');
  assert.equal(controller.getState().correctCount, 1);
});
test('late initialization cannot overwrite new session, nor can a late answer after disposal', async () => {
  const gate = deferred(); const { controller, frames } = fixture({ word: async (id) => { await gate.promise; return { english: id }; } });
  const first = controller.start('old', 1, 5); await tick();
  const second = controller.start('new', 2, 6); gate.resolve(); await Promise.all([first, second]);
  assert.match(controller.getState().questionId, /^new:6:2:/);
  const work = controller.answer('yes'); controller.dispose(); const count = frames.length;
  await work; assert.equal(frames.length, count);
});
test('wrong answer correction lasts one second from feedback, not one second after slow save', async () => {
  let now = 0, duration = null; const gate = deferred();
  const api = { skipId: 'skip', load: async () => ({ sessionKey: 'test', sourceWordIds: ['a','b'], currentIndex: 0, correctIds: [], wrongIds: [] }),
    word: async (id) => ({ english: id }), options: async () => [{ id: 'no', chinese: '错' }], save: () => gate.promise, error() {} };
  const controller = createScreeningController(api, () => {}, { performance: { now: () => now },
    setTimeout(fn, ms) { duration = ms; queueMicrotask(fn); return 1; }, clearTimeout() {} });
  await controller.start('test',1,1); const work = controller.answer('no'); now = 700; gate.resolve(); await work;
  assert.equal(duration, 300);
});
test('leaving waits for storage only; a pending feedback frame cannot keep navigation locked', async () => {
  const shown=deferred(), {controller,frames}=fixture({feedbackShown:()=>shown.promise});
  await controller.start('test',1,1);
  const work=controller.answer('no');await controller.flush();
  assert.equal(controller.getState().answered,true);
  controller.dispose();const count=frames.length;shown.resolve(performance.now());await work;
  assert.equal(frames.length,count);
});
test('word queue rolls back only failed intent, replays later intent, other words save independently', async () => {
  const records = new Map([['a', 0], ['b', 0]]), gate = deferred(), writes = []; let first = true;
  const queue = createWordSaveQueue({ read: (id) => ({ id, count: records.get(id) }),
    display: (id, record) => records.set(id, record.count), saved() {}, failed() {}, busy() {},
    write: async (record) => { if (record.id === 'a' && first) { first = false; await gate.promise; throw Error('disk full'); } writes.push(record); } });
  const inc = (record) => ({ ...record, count: record.count + 1 });
  const failed = queue.enqueue('a', inc), next = queue.enqueue('a', inc);
  await queue.enqueue('b', inc);
  assert.equal(records.get('a'), 2); assert.equal(records.get('b'), 1);
  gate.resolve(); await assert.rejects(failed); await next; await queue.flush();
  assert.equal(records.get('a'), 1);
  assert.deepEqual(writes, [{ id: 'b', count: 1 }, { id: 'a', count: 1 }]);
});
test('lasso matches legacy whole-stroke geometry for 100/1000/3000 strokes and changed points', () => {
  const polygon = [{ x:.2,y:.2 },{ x:.6,y:.2 },{ x:.55,y:.65 },{ x:.2,y:.6 }];
  for (const count of [100,1000,3000]) {
    const strokes = Array.from({ length:count }, (_, i) => ({ points:Array.from({ length:50 }, (_, j) => ({ x:((i*17+j*3)%1000)/1000,y:((i*23+j)%1000)/1000 })) }));
    const expected = strokes.filter((stroke) => !stroke.points.some((point) => pointInPolygon(point, polygon)));
    assert.deepEqual(eraseAnnotationsInPolygon(strokes,polygon), expected);
    assert.deepEqual(eraseAnnotationsInPolygon(strokes,polygon), expected);
    strokes[0].points = [{ x:.3,y:.3 }]; assert.ok(!eraseAnnotationsInPolygon(strokes,polygon).includes(strokes[0]));
  }
});
test('deletion serialization never revisits unchanged points, and retains exact backup format', () => {
  let reads = 0; const stroke = { get points() { reads++; return [{ x:.2,y:.4,pressure:.8 }]; } };
  const serializer = createInkSnapshotSerializer(); serializer('a',[stroke,{points:[]}]);
  const result = serializer('a',[stroke],{reuseUnchanged:true});
  assert.equal(reads,1); assert.equal(result.json,JSON.stringify([stroke]));
});
test('both bundle patches compose idempotently, remain valid JS, and reject an unknown bundle', () => {
  mkdirSync('output/interaction-unit', {recursive:true});
  const dir=mkdtempSync(resolve('output/interaction-unit/patch-')), file=resolve(dir,'bundle.mjs');
  const patch=()=>{for(const script of ['patch-vocabulary-bundle.mjs','patch-vocabulary-import-integration.mjs'])execFileSync(process.execPath,[`scripts/${script}`,file],{windowsHide:true});};
  const source=readFileSync('public/vocabulary/assets/index-DSvnOTE0.js','utf8').replace(/\r\n/g,'\n');
  for (const newline of ['\n','\r\n']) {
    writeFileSync(file,source.replace(/\n/g,newline));
    patch();const first=readFileSync(file,'utf8');patch();assert.equal(readFileSync(file,'utf8'),first);
    execFileSync(process.execPath,['--check',file],{windowsHide:true});
  }
  writeFileSync(file,'unknown bundle');assert.throws(patch);assert.equal(readFileSync(file,'utf8'),'unknown bundle');
});
