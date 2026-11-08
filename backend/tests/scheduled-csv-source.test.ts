import {describe,it,expect} from 'vitest';
import {validateScheduledCsvSourceContract,validateScheduledCsvRows,type AgentApprovedConfig} from '../src/records/agent-restrictions.js';
import {validateAgentConfig,type Installation} from '../src/records/agent-enrollments.js';
import {parseShipmentCsv} from '../src/records/csv.js';
const contract={schema:'packproof.scheduled-csv/v1' as const,exporterName:'Synthetic warehouse exporter',exporterVersion:'fixture-1',expectedHeaders:['Reference','Description','Quantity','Reported at'],expectedIntervalSeconds:900,backfillFrom:'2026-11-01T00:00:00-04:00'};
const config:AgentApprovedConfig={folderDigest:'a'.repeat(64),sourceName:'Scheduled source',integrationAccountId:'source-fixture',operatorMembershipId:'member-fixture',locationId:null,mapping:{shipmentReference:'Reference',itemTitle:'Description',quantity:'Quantity',shippedAt:'Reported at'},timeZone:'America/New_York',importValidRows:false,offlineWindowHours:24,sourceContract:contract};
const installation={integration_account_id:config.integrationAccountId,operator_membership_id:config.operatorMembershipId,location_id:null,source_name:config.sourceName} as Installation;
const rows=(reported='2026-11-07T09:00:00-05:00')=>parseShipmentCsv(`${contract.expectedHeaders.join(',')}\r\n000045,Fixture,1,${reported}\r\n`,config.mapping,config.timeZone).rows;
describe('administrator-approved Scheduled CSV Export Folder v1 contract',()=>{
 it('preserves exact exporter/version, headers, explicit-offset cutoff and leading-zero identities',()=>{
  expect(validateScheduledCsvSourceContract(contract)).toEqual(contract);
  expect(validateAgentConfig(config,installation)).toEqual(config);
  const accepted=rows();expect(accepted[0].normalized?.shipmentReference).toBe('000045');expect(()=>validateScheduledCsvRows(config,accepted)).not.toThrow();
 });
 it('requires an exact bounded source contract and a mapped source timestamp',()=>{
  for(const changed of [{schema:'unqualified/v2'},{expectedHeaders:['Reference','Reference']},{expectedHeaders:[' Reference']},{expectedIntervalSeconds:0},{expectedIntervalSeconds:604801},{backfillFrom:'11/01/2026'},{backfillFrom:'2026-02-30T00:00:00Z'},{backfillFrom:'2026-11-07T24:00:00Z'},{exporterVersion:''},{unknown:'private'}])expect(()=>validateScheduledCsvSourceContract({...contract,...changed})).toThrow();
  expect(()=>validateAgentConfig({...config,mapping:{shipmentReference:'Reference',itemTitle:'Description',quantity:'Quantity'}},installation)).toThrow(/timestamp/);
 });
 it('isolates schema drift before source original submission, including unmapped added columns',()=>{
  const accepted=rows();accepted[0].values.Secret='not-approved';
  expect(()=>validateScheduledCsvRows(config,accepted)).toThrow(/headers differ/);
  const reordered=rows();reordered[0].values=Object.fromEntries(Object.entries(reordered[0].values).reverse());
  expect(()=>validateScheduledCsvRows(config,reordered)).toThrow(/headers differ/);
 });
 it('uses original header order while persisted JSON row keys may be reordered',()=>{
  const parsed=rows();parsed[0].values=Object.fromEntries(Object.entries(parsed[0].values).reverse());
  expect(()=>validateScheduledCsvRows(config,parsed,contract.expectedHeaders)).not.toThrow();
  expect(()=>validateScheduledCsvRows(config,parsed,[...contract.expectedHeaders].reverse())).toThrow(/headers differ/);
 });
 it('holds pre-cutoff and timezone-ambiguous backfill without silently changing or filtering rows',()=>{
  expect(()=>validateScheduledCsvRows(config,rows('2026-10-31T23:59:59-04:00'))).toThrow(/backfill cutoff/);
  expect(()=>validateScheduledCsvRows(config,rows('2026-11-07'))).toThrow(/explicit-offset/);
  expect(()=>validateScheduledCsvRows(config,rows('2026-11-07T09:00:00'))).toThrow(/explicit-offset/);
  expect(()=>validateScheduledCsvRows(config,rows('2026-11-31T09:00:00Z'))).toThrow(/explicit-offset/);
  expect(()=>validateScheduledCsvRows(config,rows(contract.backfillFrom))).not.toThrow();
 });
 it('keeps a legacy approved configuration readable without implying source qualification',()=>{
  const {sourceContract:_,...legacy}=config;
  expect(validateAgentConfig(legacy,installation)).toEqual(legacy);
  expect(()=>validateScheduledCsvRows(legacy,rows('2026-11-07'))).not.toThrow();
 });
});
