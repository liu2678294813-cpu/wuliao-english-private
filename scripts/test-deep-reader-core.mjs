import test from 'node:test';
import assert from 'node:assert/strict';
import * as flow from '../src/readingFlow.js';
import { createUnknownSelectionHooks } from '../src/unknownWordInteraction.js';
import { LONG_PRESS_MS } from '../src/inkEngine.js';

test('first redo requires translation completion; historical skipped redo survives reload', () => {
  const initial = flow.emptyFlow('r','p', 1);
  assert.equal(flow.enterReadingStage(initial, 'deep-redo', 10), initial);
  assert.equal(flow.hasReachedStage(initial, 'deep-redo'), false);
  const translation = { ...initial, currentStage: 'deep-translation', stages: {
    ...initial.stages, 'deep-translation': { status: 'current', completedAt: null, visitedAt: 8 },
  } };
  const next = flow.completeStage(translation, 'deep-translation', 10);
  assert.equal(next.currentStage, 'deep-redo');
  assert.equal(next.stages['deep-translation'].status, 'completed');
  assert.equal(flow.normalizeFlow(next).currentStage, 'deep-redo');
  assert.equal(flow.activeQuestionAttempt(next), 'redo');
  const first = flow.enterReadingStage(next, 'deep-translation', 20);
  assert.equal(flow.activeQuestionAttempt(first), 'first');
  assert.equal(flow.hasReachedStage(first, 'deep-redo'), true);
  const historical = flow.normalizeFlow({ ...next, currentStage: 'deep-translation', stages: {
    ...next.stages, 'deep-translation': { status: 'skipped', completedAt: null },
    'deep-redo': { status: 'pending', completedAt: null, visitedAt: 10 },
  } });
  assert.equal(flow.hasReachedStage(historical, 'deep-redo'), true);
  const ended = flow.completeStage(flow.completeStage(next, 'deep-redo', 30), 'deep-review', 40);
  assert.equal(ended.stages['deep-redo'].status, 'completed');
  assert.equal(flow.isWorkflowCompleted(ended), false);
  assert.equal(initial.currentStage, 'deep-cover');
});
test('redo navigation during initial timer is rejected without changing timer', () => {
  const initial = flow.enterInitialStage({...flow.emptyFlow('r','p',1),currentStage:'deep-clean-text'},10);
  const next = flow.enterReadingStage(initial,'deep-redo',100);
  assert.equal(next, initial);
  assert.equal(next.timedReading.phase,'running');
  assert.equal(flow.isStageLocked(initial,'deep-redo'),true);
});
test('leaving a reached unfinished review never locks it again after reload', () => {
  const initial = flow.emptyFlow('r', 'p', 1);
  const translation = { ...initial, currentStage: 'deep-translation', stages: { ...initial.stages, 'deep-translation': { status: 'current', completedAt: null } } };
  const redo = flow.completeStage(translation, 'deep-translation', 10);
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
