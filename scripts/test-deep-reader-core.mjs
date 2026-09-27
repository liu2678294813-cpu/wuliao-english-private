import test from 'node:test';
import assert from 'node:assert/strict';
import * as flow from '../src/readingFlow.js';
import { createUnknownSelectionHooks } from '../src/unknownWordInteraction.js';
import { LONG_PRESS_MS } from '../src/inkEngine.js';

test('explicit redo survives reload without inventing translation completion', () => {
  const initial = flow.emptyFlow('r','p', 1);
  const next = flow.enterReadingStage(initial, 'deep-redo', 10);
  assert.equal(next.currentStage, 'deep-redo');
  assert.equal(next.stages['deep-translation'].status, 'skipped');
  assert.equal(next.stages['deep-translation'].completedAt, null);
  assert.equal(flow.normalizeFlow(next).currentStage, 'deep-redo');
  assert.equal(flow.activeQuestionAttempt(next), 'redo');
  const first = flow.enterReadingStage(next, 'deep-translation', 20);
  assert.equal(flow.activeQuestionAttempt(first), 'first');
  const ended = flow.completeStage(flow.completeStage(next, 'deep-redo', 30), 'deep-review', 40);
  assert.equal(flow.isWorkflowCompleted(ended), true);
  assert.equal(ended.stages['deep-translation'].status, 'skipped');
  assert.equal(initial.currentStage, 'deep-cover');
});
test('redo navigation pauses running initial timer and never completes it', () => {
  const initial = flow.enterInitialStage({...flow.emptyFlow('r','p',1),currentStage:'deep-clean-text'},10);
  const next = flow.enterReadingStage(initial,'deep-redo',100);
  assert.equal(next.timedReading.phase,'paused');
  assert.equal(next.timedReading.elapsedMs,90);
  assert.equal(next.timedReading.completedAt,null);
  assert.equal(flow.isStageLocked(initial,'deep-redo'),false);
});
test('leaving a reached unfinished review never locks it again after reload', () => {
  const redo = flow.enterReadingStage(flow.emptyFlow('r', 'p', 1), 'deep-redo', 10);
  const review = flow.completeStage(redo, 'deep-redo', 20);
  const earlier = flow.enterReadingStage(review, 'deep-cover', 30);
  const reloaded = flow.normalizeFlow(earlier);
  assert.equal(flow.isStageLocked(reloaded, 'deep-review'), false);
  const resumed = flow.enterReadingStage(reloaded, 'deep-review', 40);
  assert.equal(resumed.currentStage, 'deep-review');
  assert.equal(resumed.stages['deep-review'].completedAt, null);
  assert.equal(flow.isWorkflowCompleted(resumed), false);
});
test('unknown pen miss changes refs within the current pointerdown, token hits stay unknown', () => {
  for (const [pointerType,hit,expectPen] of [['pen',false,true],['pen',true,false],['touch',false,false],['mouse',false,false]]) {
    const toolRef={current:'unknown'}, selectionRef={current:null};
    let switched=0;
    const hooks=createUnknownSelectionHooks({toolRef,selectionRef,fallbackToPenOnPenMiss:true,
      isWritingArea:()=>true,onCollect:()=>hit?{word:'bank'}:null,onCommit:()=>{},
      onRequestPenMode:()=>{toolRef.current='pen';switched++;}});
    const result=hooks.beforeInkDown({pointerId:1,pointerType});
    assert.equal(toolRef.current,expectPen?'pen':'unknown');
    assert.equal(result,expectPen?undefined:'abort');
    assert.equal(switched,expectPen?1:0);
  }
});
test('unknown default and non-writing area keep existing selection behavior',()=>{
  for (const enabled of [false,true]) {
    const toolRef={current:'unknown'},selectionRef={current:null};
    const hooks=createUnknownSelectionHooks({toolRef,selectionRef,fallbackToPenOnPenMiss:enabled,
      isWritingArea:()=>false,onCollect:()=>null,onCommit:()=>{},onRequestPenMode:()=>{throw Error('must not switch')}});
    assert.equal(hooks.beforeInkDown({pointerId:1,pointerType:'pen'}),'abort');
  }
});
test('long press is reduced by exactly one quarter',()=>assert.equal(LONG_PRESS_MS,465));
