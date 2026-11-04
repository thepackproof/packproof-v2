import {describe,it,expect} from 'vitest';
import {connectionHealth} from '../src/records/connections.js';
describe('measured connection freshness',()=>{
 const now=new Date('2026-11-04T12:00:00Z');
 it('never infers freshness from authentication or a historical file',()=>{
  expect(connectionHealth({provider:'erp'},now).state).toBe('freshness_unknown');
  expect(connectionHealth({provider:'csv',paused:true},now).state).toBe('not_applicable');
 });
 it('requires source success and watermark evidence within the configured cadence',()=>{
  const source={provider:'erp',last_success_at:'2026-11-04T11:59:30Z',watermark_checked_at:'2026-11-04T11:59:30Z',expected_interval_seconds:60};
  expect(connectionHealth(source,now).state).toBe('up_to_date');
  expect(connectionHealth({...source,watermark_checked_at:null},now).state).toBe('freshness_unknown');
  expect(connectionHealth({...source,watermark_checked_at:'2026-11-04T11:58:00Z'},now).state).toBe('delayed');
  expect(connectionHealth({...source,last_success_at:'2026-11-04T12:01:00Z',watermark_checked_at:'2026-11-04T12:01:00Z'},now).state).toBe('freshness_unknown');
  expect(connectionHealth({...source,last_success_at:'2026-11-04T12:01:00Z'},now).state).toBe('freshness_unknown');
  expect(connectionHealth({...source,watermark_checked_at:'2026-11-04T12:01:00Z'},now).state).toBe('freshness_unknown');
  expect(connectionHealth({...source,expected_interval_seconds:-60},now).state).toBe('freshness_unknown');
 });
 it('keeps intervention and deliberate pauses visible',()=>{
  expect(connectionHealth({provider:'erp',last_error_code:'PERMISSION_DENIED'},now).state).toBe('action_needed');
  expect(connectionHealth({provider:'erp',paused:true,last_error_code:'PERMISSION_DENIED'},now).state).toBe('paused');
 });
});
