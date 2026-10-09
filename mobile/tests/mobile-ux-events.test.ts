import test from 'node:test';
import assert from 'node:assert/strict';
import { clearMobileUxMetrics, mobileUxEvents, readMobileUxMetrics, readMobileUxIndicators, observeMobileDraftRoute, recordMobileUxEvent, startMobileCaptureEntry, type MobileUxEvent } from '../src/analytics/mobile-ux-events';

test('UX metrics retain only bounded named aggregates and approved numeric durations',()=>{
  clearMobileUxMetrics();
  const supplied={durationMs:1200,proofId:'private-proof',token:'secret',tracking:'private-tracking',media:'private-media'};
  recordMobileUxEvent('capture_entered',supplied);
  recordMobileUxEvent('capture_entered',{durationMs:800});
  recordMobileUxEvent('secret-event' as MobileUxEvent,{durationMs:2});
  const summary=readMobileUxMetrics();
  assert.equal(Object.keys(summary.events).length,mobileUxEvents.length);
  assert.deepEqual(summary.events.capture_entered,{count:2,totalDurationMs:2000,durationSamples:2,maxDurationMs:1200});
  assert.doesNotMatch(JSON.stringify(summary),/private|secret|token|tracking|media/);
  summary.events.capture_entered.count=100;
  assert.equal(readMobileUxMetrics().events.capture_entered.count,2);
});
test('time to camera entry consumes only the deliberate task timer and clears across accounts',()=>{
  clearMobileUxMetrics();
  startMobileCaptureEntry();
  recordMobileUxEvent('capture_entered');
  recordMobileUxEvent('capture_entered');
  assert.equal(readMobileUxMetrics().events.capture_entered.durationSamples,1);
  startMobileCaptureEntry();
  clearMobileUxMetrics();
  recordMobileUxEvent('capture_entered');
  assert.equal(readMobileUxMetrics().events.capture_entered.durationSamples,0);
});

test('invalid durations cannot corrupt aggregates and account reset clears all counts',()=>{
  clearMobileUxMetrics();
  for(const durationMs of [-1,NaN,Infinity,86_400_001]) recordMobileUxEvent('review_completed',{durationMs});
  assert.deepEqual(readMobileUxMetrics().events.review_completed,{count:4,totalDurationMs:0,durationSamples:0,maxDurationMs:0});
  clearMobileUxMetrics();
  assert.ok(Object.values(readMobileUxMetrics().events).every(value=>value.count===0&&value.totalDurationMs===0));
});

test('draft exits are observed once across preparation routes and never inferred at account reset',()=>{
  clearMobileUxMetrics();
  observeMobileDraftRoute('draft'); observeMobileDraftRoute('draft');
  observeMobileDraftRoute('other'); observeMobileDraftRoute('other');
  observeMobileDraftRoute('draft'); observeMobileDraftRoute('capture');
  recordMobileUxEvent('capture_entered',{durationMs:100}); observeMobileDraftRoute('other');
  recordMobileUxEvent('review_completed'); recordMobileUxEvent('upload_intervention'); recordMobileUxEvent('finalization');
  assert.equal(readMobileUxMetrics().events.draft_started.count,2);
  assert.equal(readMobileUxMetrics().events.draft_left_before_capture.count,1);
  assert.deepEqual(readMobileUxIndicators(),{meanTimeToCaptureEntryMs:100,observedDraftExitRate:0.5,uploadInterventionsPerReview:1,completedFinalizations:1});
  observeMobileDraftRoute('draft'); clearMobileUxMetrics(); observeMobileDraftRoute('other');
  assert.equal(readMobileUxMetrics().events.draft_left_before_capture.count,0);
  assert.equal(readMobileUxIndicators().observedDraftExitRate,null);
});
