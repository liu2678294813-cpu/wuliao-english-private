import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryProgress } from '../public/vocabulary/memory-modes.js';
import { withMemoryProgress, clearUndoEntries } from '../public/vocabulary/memory-record.js';

test('all legacy progress states remain readable without migrating or writing records', () => {
  const records = [{clickCount:3}, {clickCount:1}, {modeProgress:{cycle:3}},
    {sharedProgress:{count:3,masked:true}}, {sharedProgress:{count:0,masked:false},clickCount:3,maskedDates:['2026-09-01']}];
  const original=structuredClone(records);
  assert.deepEqual(records.map(memoryProgress),[5,2,3,5,0]);
  assert.deepEqual(records,original);
});

test('clear recovery survives serialization; later learning and review writes supersede it', () => {
  const previous = {wordId:'one',username:'a',listKey:'original',clickCount:3,maskedAt:1234,maskedDates:['2026-08-01']};
  const cleared=withMemoryProgress(previous,'one',0,{username:'a',listKey:'original',now:2000});
  cleared.clearUndo={batchId:2000,step:5,clearedAt:2000,maskedAt:previous.maskedAt,maskedDates:previous.maskedDates};
  assert.deepEqual(clearUndoEntries(JSON.parse(JSON.stringify([cleared]))),[{wordId:'one',step:5,clearUndo:cleared.clearUndo}]);
  const updated=withMemoryProgress(cleared,'one',2,{username:'a',listKey:'original',now:3000});
  assert.equal(updated.clearUndo,undefined);
  assert.deepEqual(clearUndoEntries([updated]),[]);
  const reviewed=withMemoryProgress(cleared,'one',0,{username:'a',listKey:'original',now:3000});
  assert.equal(reviewed.clearUndo,undefined);
  assert.deepEqual(reviewed.maskedDates,previous.maskedDates);
});

test('only the latest valid clear batch is restorable, without reviving later writes', () => {
  const row=(wordId,batchId,updatedAt=100)=>({wordId,sharedProgress:{count:0,masked:false},updatedAt,clearUndo:{batchId,step:5,clearedAt:100}});
  assert.deepEqual(clearUndoEntries([row('old',1),row('new',2),row('changed',2,200)]).map(x=>x.wordId),['new']);
});

test('GitHub upgrade identities stay stable for Android and the portable Windows browser origin', () => {
  const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
  const capacitor=JSON.parse(read('../capacitor.config.json'));
  assert.equal(capacitor.appId,'com.wuliao.english');
  assert.equal(capacitor.server.androidScheme,'https');
  assert.match(read('./start.mjs'),/const port = 4173;/);
  assert.match(read('./start.mjs'),/http:\/\/127\.0\.0\.1:\$\{port\}/);
});
