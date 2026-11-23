import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRecoveryImages} from './recovery-image-builds.mjs';
import {selectRecoveryBuild,startOrResumeRecoveryBuild,verifyRecoveryBuildObservation,
  publicRecoveryBuildPins,recoveryBuildDiscoveryLimit} from './recovery-build-resume.mjs';

const repository='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api';
const pins={source:'a'.repeat(40),archiveSha256:'b'.repeat(64),sourceVersion:'version-123',
  predecessorImage:repository+'@sha256:'+'c'.repeat(64)};
const prepared=prepareRecoveryImages(pins);
const id=n=>'packproof-v2-staging-api:'+String(n).padStart(8,'0')+'-0000-0000-0000-000000000000';
function build(n=1,overrides={}) {
  const {request}=prepared;
  return {id:id(n),projectName:request.projectName,buildStatus:'IN_PROGRESS',buildComplete:false,
    source:{type:'S3',location:request.sourceLocationOverride,buildspec:request.buildspecOverride},
    sourceVersion:request.sourceVersion,environment:{environmentVariables:[
      ...structuredClone(request.environmentVariablesOverride),{name:'PROJECT_DEFAULT',type:'PLAINTEXT',value:'retained'}
    ]},...overrides};
}
function unrelated(n=2) {
  const other=prepareRecoveryImages({...pins,source:'d'.repeat(40)});
  return build(n,{source:{type:'S3',location:other.request.sourceLocationOverride,buildspec:other.request.buildspecOverride},
    environment:{environmentVariables:other.request.environmentVariablesOverride}});
}
function io(pages,records) {
  const calls=[],discoveries=[],started=[];
  return {calls,discoveries,started,
    listBuilds:async params=>{calls.push(['list',params]);return pages.shift();},
    readBuilds:async params=>{calls.push(['read',params]);return {builds:params.ids.map(key=>records.find(b=>b.id===key)).filter(Boolean)};},
    startBuild:async request=>{calls.push(['start',request]);return {build:build(99)};},
    recordDiscovery:async receipt=>{calls.push(['discovery']);discoveries.push(receipt);},
    recordStarted:async receipt=>{calls.push(['started']);started.push(receipt);}
  };
}

test('one exact running or successful execution is selected across unrelated project history',()=>{
  for(const current of [build(),build(1,{buildStatus:'SUCCEEDED',buildComplete:true})]) {
    const records=[unrelated(),current],before=structuredClone(records);
    assert.equal(selectRecoveryBuild(prepared,records),current);
    assert.deepEqual(records,before);
  }
  assert.equal(selectRecoveryBuild(prepared,[unrelated()]),null);
  assert.equal(selectRecoveryBuild(prepared,[]),null);
});

test('same-source changed project, archive, version, buildspec or override pins cannot be resumed',()=>{
  const mutations=[
    b=>b.projectName='another-project',
    b=>b.source.type='GITHUB',
    b=>b.source.location=b.source.location.replace(pins.archiveSha256,'e'.repeat(64)),
    b=>b.sourceVersion='another-version',
    b=>b.source.buildspec+='\n',
    ...prepared.request.environmentVariablesOverride.map(wanted=>b=>{
      b.environment.environmentVariables.find(v=>v.name===wanted.name).value='changed';
    }),
    b=>b.environment.environmentVariables[0].type='SECRETS_MANAGER',
    b=>b.environment.environmentVariables.push({...b.environment.environmentVariables[0]}),
    b=>delete b.environment
  ];
  for(const mutate of mutations) {
    const current=build();mutate(current);
    assert.throws(()=>selectRecoveryBuild(prepared,[current]),/DISCOVERY_BINDING|DISCOVERY_UNCLASSIFIABLE|SAME_SOURCE_CONFLICT/);
  }
  assert.throws(()=>verifyRecoveryBuildObservation({...build(),id:'unrelated:secret'},prepared),/SAME_SOURCE_CONFLICT/);
});

test('duplicate exact builds, failed same-source builds and inconsistent states are refused',()=>{
  assert.throws(()=>selectRecoveryBuild(prepared,[build(1),build(2)]),/DUPLICATE_MATCH/);
  for(const status of ['FAILED','FAULT','STOPPED','TIMED_OUT']) {
    assert.throws(()=>selectRecoveryBuild(prepared,[build(1),build(2,{buildStatus:status,buildComplete:true})]),/SAME_SOURCE_FAILED/);
  }
  for(const bad of [{buildStatus:'UNKNOWN'},{buildComplete:true},{buildStatus:'SUCCEEDED',buildComplete:false}])
    assert.throws(()=>selectRecoveryBuild(prepared,[build(1,bad)]),/STATE/);
});

test('discovery paginates explicitly, resumes the exact ID and persists receipts before returning to polling',async()=>{
  const current=build(),old=unrelated();
  const fake=io([{ids:[old.id],nextToken:'page-two'},{ids:[current.id]}],[old,current]);
  const result=await startOrResumeRecoveryBuild(prepared,fake);
  assert.equal(result.build.id,current.id);assert.equal(result.resumed,true);
  assert.deepEqual(fake.calls.map(([action])=>action),['list','read','list','read','discovery','started']);
  assert.deepEqual(fake.calls[2][1],{projectName:prepared.request.projectName,nextToken:'page-two'});
  assert.deepEqual(fake.discoveries[0].matchingBuilds,[{id:current.id,status:'IN_PROGRESS'}]);
  assert.equal(fake.discoveries[0].complete,true);
  assert.deepEqual(fake.started[0],{schema:'packproof.recovery-build-started/v1',source:pins.source,
    buildId:current.id,status:'IN_PROGRESS',resumed:true,requestPinsVerified:true});
});

test('only a complete unrelated history permits one start and the returned ID is recorded before polling',async()=>{
  const old=unrelated(),fake=io([{ids:[old.id]}],[old]);
  const result=await startOrResumeRecoveryBuild(prepared,fake);
  assert.equal(result.resumed,false);assert.equal(result.build.id,id(99));
  assert.deepEqual(fake.calls.map(([action])=>action),['list','read','discovery','start','started']);
  assert.deepEqual(fake.calls.find(([action])=>action==='start')[1],prepared.request,'Buildspec and source request remain identical.');
  assert.equal(fake.started[0].requestPinsVerified,true);
  const blocked=io([{ids:[]}],[]);
  blocked.recordStarted=async receipt=>{blocked.started.push(receipt);throw Error('receipt write failed');};
  await assert.rejects(startOrResumeRecoveryBuild(prepared,blocked),/receipt write failed/);
  assert.equal(blocked.started[0].buildId,id(99),'The actual response is available to persist before polling is permitted.');
});

test('a failed, conflicting or duplicate same-source build leaves a bounded diagnostic receipt and never starts again',async()=>{
  for(const records of [
    [build(1,{buildStatus:'FAILED',buildComplete:true})],
    [build(1,{sourceVersion:'conflicting-version'})],
    [build(1),build(2)]
  ]) {
    records[0].privateRaw='must-not-be-published';
    const fake=io([{ids:records.map(b=>b.id)}],records);
    await assert.rejects(startOrResumeRecoveryBuild(prepared,fake),/SAME_SOURCE_FAILED|SAME_SOURCE_CONFLICT|DUPLICATE_MATCH/);
    assert.equal(fake.discoveries[0].complete,true);
    assert.deepEqual(fake.discoveries[0].matchingBuilds,records.map(b=>({id:b.id,status:b.buildStatus})));
    assert.doesNotMatch(JSON.stringify(fake.discoveries),/must-not-be-published|buildspec|environment|PREDECESSOR/);
    assert.ok(!fake.calls.some(([action])=>action==='start'));
  }
});

test('incomplete history, repeated tokens, duplicate IDs and missing metadata fail closed without starting',async()=>{
  const pages=Array.from({length:recoveryBuildDiscoveryLimit.pages},(_,n)=>({ids:[],nextToken:'page-'+n}));
  const examples=[
    io(pages,[]),
    io([{ids:[],nextToken:'same'},{ids:[],nextToken:'same'}],[]),
    io([{ids:[id(1),id(1)]}],[build()]),
    io([{ids:[id(1)]}],[]),
    io([{ids:[id(1)],nextToken:'next'},{ids:[id(1)]}],[build()])
  ];
  for(const fake of examples) {
    await assert.rejects(startOrResumeRecoveryBuild(prepared,fake),/DISCOVERY_LIMIT|DISCOVERY_TOKEN|DISCOVERY_IDS|DISCOVERY_MISSING/);
    assert.equal(fake.discoveries[0].complete,false);
    assert.ok(!fake.calls.some(([action])=>action==='start'));
  }
  const notFound=io([{ids:[id(1)]}],[build()]);
  notFound.readBuilds=async()=>({builds:[build()],buildsNotFound:[id(1)]});
  await assert.rejects(startOrResumeRecoveryBuild(prepared,notFound),/DISCOVERY_MISSING/);
  assert.ok(!notFound.calls.some(([action])=>action==='start'));
});

test('discovery receipts cap same-source identities and never serialize raw AWS fields or unknown status text',async()=>{
  const records=Array.from({length:25},(_,n)=>build(n+1));
  records[0].buildStatus='private diagnostic text';
  const fake=io([{ids:records.map(b=>b.id)}],records);
  await assert.rejects(startOrResumeRecoveryBuild(prepared,fake),/STATE/);
  const receipt=fake.discoveries[0];
  assert.equal(receipt.matchingBuildCount,25);
  assert.equal(receipt.matchingBuilds.length,recoveryBuildDiscoveryLimit.receiptMatches);
  assert.equal(receipt.matchingBuildsTruncated,true);
  assert.equal(receipt.matchingBuilds[0].status,'UNRECOGNIZED');
  assert.doesNotMatch(JSON.stringify(receipt),/private diagnostic text|PROJECT_DEFAULT|buildspec/);
});

test('even an immediately failed or differently pinned StartBuild response is recorded before refusal',async()=>{
  for(const changed of [{buildStatus:'FAILED',buildComplete:true},{sourceVersion:'changed'}]) {
    const fake=io([{ids:[]}],[]);
    fake.startBuild=async()=>({build:build(99,changed)});
    await assert.rejects(startOrResumeRecoveryBuild(prepared,fake),/SAME_SOURCE_FAILED|SAME_SOURCE_CONFLICT/);
    assert.equal(fake.started[0].buildId,id(99));
    assert.equal(fake.started[0].resumed,false);
  }
});

test('verified console pins contain only bounded public image identities and no additional release metadata',()=>{
  const verified={source:pins.source,archiveSha256:pins.archiveSha256,sourceVersion:pins.sourceVersion,buildId:id(1),
    predecessor:pins.predecessorImage,candidate:repository+'@sha256:'+'d'.repeat(64),fallback:repository+'@sha256:'+'e'.repeat(64),
    raw:{secret:'must-not-appear'},buildLog:{events:['must-not-appear']},ciRunId:123};
  const receipt=publicRecoveryBuildPins(verified);
  assert.deepEqual(Object.keys(receipt),['source','archiveSha256','sourceVersion','buildId','predecessor','candidate','fallback']);
  assert.doesNotMatch(JSON.stringify(receipt),/must-not-appear|buildLog|ciRunId/);
  assert.ok(JSON.stringify(receipt).length<2048);
  for(const changed of [{buildId:'other-project:build'},{sourceVersion:'null'},{sourceVersion:'v'.repeat(1025)},
    {candidate:repository+':latest'},{fallback:verified.candidate},{source:'not-reviewed'}])
    assert.throws(()=>publicRecoveryBuildPins({...verified,...changed}),/PUBLIC_RECEIPT/);
});

test('missing or malformed source and environment metadata cannot classify a build as unrelated or authorize StartBuild',async()=>{
  for(const mutate of [
    b=>{delete b.source;delete b.environment;},
    b=>delete b.source,
    b=>delete b.environment,
    b=>delete b.source.location,
    b=>delete b.source.type,
    b=>b.source.type='UNRECOGNIZED',
    b=>delete b.environment.environmentVariables,
    b=>b.environment.environmentVariables={},
    b=>b.environment.environmentVariables=[{name:'UNKNOWN',value:'private-value'}]
  ]) {
    const incomplete=unrelated();mutate(incomplete);
    assert.throws(()=>selectRecoveryBuild(prepared,[incomplete]),/DISCOVERY_UNCLASSIFIABLE/);
    const fake=io([{ids:[incomplete.id]}],[incomplete]);
    await assert.rejects(startOrResumeRecoveryBuild(prepared,fake),/DISCOVERY_UNCLASSIFIABLE/);
    assert.equal(fake.discoveries.length,1);
    assert.equal(fake.discoveries[0].complete,false);
    assert.equal(fake.discoveries[0].observedBuilds,1);
    assert.doesNotMatch(JSON.stringify(fake.discoveries),/private-value/);
    assert.ok(!fake.calls.some(([action])=>action==='start'));
  }
});

test('only the exact project and canonical hexadecimal build UUID may enter public discovery receipts',async()=>{
  for(const invalid of [
    'packproof-v2-staging-api:private-metadata',
    'packproof-v2-staging-api:00000001-0000-0000-0000-000000000000-extra',
    'other-project:00000001-0000-0000-0000-000000000000'
  ]) {
    const fake=io([{ids:[invalid]}],[]);
    await assert.rejects(startOrResumeRecoveryBuild(prepared,fake),/DISCOVERY_IDS/);
    assert.deepEqual(fake.discoveries[0].matchingBuilds,[]);
    assert.ok(!JSON.stringify(fake.discoveries).includes(invalid));
    assert.ok(!fake.calls.some(([action])=>action==='start'));
  }
});
