/** Versioned Connect sources and canonical order projection contracts. */
export function addOrderWorkspaceContract(api) {
  const ref = name => ({$ref:'#/components/schemas/'+name});
  const string = {type:'string',minLength:1,maxLength:200};
  const hash = {type:'string',pattern:'^[a-f0-9]{64}$'};
  const num = {type:'integer',minimum:1};
  const seq = {type:'integer',minimum:0};
  const open = {type:'object',additionalProperties:true};
  const obj = (properties,required=Object.keys(properties)) => ({type:'object',additionalProperties:false,properties,required});
  const array = (items,maxItems) => ({type:'array',items,...(maxItems?{maxItems}:{})});
  const enumOf = (...values) => ({enum:values});
  const ws = {organizationId:string,environment:enumOf('sandbox','live')};
  const profile = {sourceId:string,generation:num};
  const qualified = {...profile,scopeDigest:hash};
  const kinds = enumOf('order','picking','packing','evidence','label','handoff','delivery','return','correction');
  const query = (name,schema,required=false) => ({name,in:'query',required,schema});
  const location = query('locationId',string);
  const size = query('limit',{type:'integer',minimum:1,maximum:100});
  const search = [query('q',string),query('before',num),query('dayStart',{type:'string',format:'date-time'}),size,
    query('referenceType',enumOf('any','order','pick','package','shipment','tracking'))];
  const schemas = api.components.schemas;
  const line = {lineId:string,sku:{type:['string','null']},unit:{type:['string','null']},title:{type:['string','null']},description:{type:['string','null']},shipmentReference:{type:['string','null']}};
  for(const field of ['orderedQuantity','pickedQuantity','packedQuantity','loadedQuantity','shippedQuantity','acknowledgedQuantity','backorderedQuantity','returnedQuantity','cancelledQuantity'])line[field]={type:['string','null'],pattern:'^(?:[0-9]{1,18}(?:\\.[0-9]{1,9})?)?$'};
  for(const field of Object.keys(line).filter(f=>f.endsWith('Quantity')))line[field+'State']={enum:['not_due','missing','unavailable','reported','not_reported','scheduled','',null]};
  schemas.ConnectOrderLine=obj(line,['lineId']);
  schemas.ConnectProjectedOrderLine=obj({...line,
    orderedMinusShippedQuantity:{type:'string',pattern:'^-?[0-9]+(?:\\.[0-9]{1,9})?$',description:'Exact ordered minus shipped. Present when both source quantities have the same unambiguous unit.'},
    loadedMinusAcknowledgedQuantity:{type:'string',description:'Exact loaded minus acknowledged for matching fulfillment scopes and known comparable units.'},
    loadedAcknowledgedDiscrepancy:{type:'string',description:'Human-readable difference between explicitly recorded loaded and acknowledged quantities.'},
    orderedShippedDiscrepancy:{type:'string',description:'Human-readable difference when ordered and shipped quantities differ.'}
  },['lineId']);
  schemas.ConnectEntityReference=obj({namespace:string,type:string,id:string});
  schemas.ConnectNormalizedEvent=obj({
    eventId:string,version:string,kind:kinds,facilityId:{type:['string','null'],description:'Optional canonical facility within this authorized operation. External site labels remain source fields.'},entity:ref('ConnectEntityReference'),references:array(ref('ConnectEntityReference'),32),
    fields:{type:'object',maxProperties:96,additionalProperties:{type:['string','boolean','null']}},
    lines:array(ref('ConnectOrderLine'),256),occurredAt:{type:['string','null'],format:'date-time'},sourceModifiedAt:{type:['string','null'],format:'date-time'},
    locator:{type:'string',maxLength:1600},fieldLineage:{type:'object',maxProperties:160,additionalProperties:{type:'string',maxLength:1600}}
  },['eventId','version','kind','entity','references','fields','locator']);
  schemas.ConnectSourceScope=obj({
    id:string,generation:num,displayName:{type:'string',maxLength:1024},folderDigest:hash,
    roles:array(enumOf('order','picking','packing','shipping','handoff','delivery','returns','evidence'),8),
    profileVersion:string,transport:enumOf('folder','api'),sourceNamespace:string
  },['id','generation','folderDigest','roles','profileVersion']);
  schemas.ConnectOperationScope=obj({sources:array(ref('ConnectSourceScope'),64),history:{const:'existing_and_future'},outputDigest:hash,outputName:{type:'string',maxLength:1024}},['sources','history','outputDigest']);
  schemas.ConnectOperationBinding=obj({installationId:string,...qualified});
  schemas.OrderImport.properties.connectOperation=ref('ConnectOperationBinding');
  schemas.OrderImport.properties.orderLines=array(ref('ConnectOrderLine'),256);
  const observation={observationId:string,fileName:{type:'string',maxLength:255},originalSha256:hash,originalBase64:{type:'string',contentEncoding:'base64',maxLength:4194304},mediaType:string,records:array(ref('ConnectNormalizedEvent'),512),issues:array(string,64)};
  schemas.ConnectObservationFile=obj(observation,Object.keys(observation).filter(k=>k!=='issues'));
  schemas.ConnectSourceSubmission=obj({...qualified,profileVersion:string,...observation},[...Object.keys(qualified),'profileVersion',...Object.keys(observation).filter(k=>k!=='issues')]);
  const version={proofId:string,revision:num};
  schemas.ConnectProofRevision={type:'object',required:['proofId','revision','orderReference','updatedAt','events','lines','evidence'],properties:{...version,orderReference:string,updatedAt:{type:'string',format:'date-time'},facilities:array(string),lines:array(ref('ConnectProjectedOrderLine')),events:array(open),evidence:array(open),originalArtifacts:array(open),conflicts:array(string),integrity:{const:'source_reported'}}};
  const summary=obj({...version,orderReference:string,updatedAt:{type:'string',format:'date-time'},customerName:string,latestKind:string,fulfillmentStatus:string,issue:{type:'string'}},['proofId','revision','orderReference','updatedAt']);
  schemas.ConnectProofPage=obj({orders:array(summary),cursor:seq,totalOrders:seq,updatedLast24Hours:seq,updatedToday:seq,nextBefore:{type:['integer','null'],minimum:1}},['orders','cursor']);
  schemas.ConnectProofChanges=obj({changes:array(obj({...version,sequence:seq})),nextCursor:seq,hasMore:{type:'boolean'}});
  schemas.ConnectScopeSession={type:'object',required:['state','scopeDigest','approvalPath'],properties:{id:string,state:enumOf('draft','pending','active','denied','superseded','expired'),scopeDigest:{anyOf:[hash,{type:'null'}]},approvalPath:{type:['string','null']},scope:ref('ConnectOperationScope'),deviceName:string,offlineWindowSeconds:seq}};
  schemas.ConnectObservationReceipt={type:'object',properties:{receiptId:string,state:enumOf('accepted','pending'),proofs:array(obj(version)),originalSha256:hash,issues:array(string),code:string},required:['receiptId','state','proofs','originalSha256']};
  schemas.ConnectReviewList=obj({items:array(open),hasMore:{type:'boolean'},orderIssues:array(summary),orderIssueCount:seq,nextIssuesBefore:{type:['integer','null'],minimum:1}},['items','hasMore']);
  const media=(schema)=>({'application/json':{schema}});
  function op(method,path,description,response,{body,params=[],idempotent=false,status=200,queryWorkspace=false}={}){
    const human=path.startsWith('/me');
    const parameters=[...path.matchAll(/\{(\w+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:m[1]==='revision'?num:string}));
    if(queryWorkspace)for(const [name,schema] of Object.entries(ws))parameters.push(query(name,schema,true));
    if(idempotent)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:string});
    parameters.push(...params);
    const def={operationId:'connect_'+method+'_'+path.replace(/[^\w]+/g,'_').replace(/^_|_$/g,''),summary:description,security:[{[human?'PersonSession':'PartnerCredential']:[]}],parameters,responses:{[status]:{description:'Authorized result.',content:media(response)},default:{description:'Scoped request rejected or requires action.',content:media(ref('Problem'))}}};
    if(body)def.requestBody={required:true,content:media(body)};
    (api.paths[path]??={})[method]=def;
  }
  const agent='/v1/partner/agent/',human='/me/records/',session=human+'agent-installations/{installationId}/order-workspace/{sessionId}';
  op('post',agent+'order-workspace/proposals','Review exact source and output scope',ref('ConnectScopeSession'),{body:ref('ConnectOperationScope')});
  op('get',agent+'order-workspace','Read current authorization session',ref('ConnectScopeSession'));
  op('get',session,'Inspect this installation approval',ref('ConnectScopeSession'),{queryWorkspace:true});
  op('post',session+'/decision','Approve or decline the exact pending scope',ref('ConnectScopeSession'),{body:obj({...ws,decision:enumOf('approve','deny'),scopeDigest:hash})});
  op('post',agent+'order-workspace/observations','Submit original bytes and versioned source interpretations',ref('ConnectObservationReceipt'),{body:ref('ConnectSourceSubmission')});
  op('post','/v1/partner/order-workspace/events','Submit a directly authorized API order event',ref('ConnectObservationReceipt'),{status:202,idempotent:true,body:obj({integrationAccountId:string,operatorMembershipId:string,connectOperation:ref('ConnectOperationBinding'),observation:ref('ConnectObservationFile')})});
  op('post',agent+'order-workspace/derivatives','Attach derived media text and location lineage to a retained original',open,{body:obj({...qualified,observationId:string,originalSha256:hash,readerVersion:string,format:string,rows:array(open,200),issues:array(string,64)})});
  op('post',agent+'order-workspace/reconcile-api-source','Process a bounded page of approved historical API snapshots',open,{body:obj(qualified)});
  op('post',agent+'order-workspace/api-source-pause','Pause or resume one approved API source',open,{body:obj({...qualified,paused:{type:'boolean'}})});
  for(const base of [agent,human]){
    const opts=base===human?{queryWorkspace:true,params:[location]}:{};
    op('get',base+'order-attention','List unresolved order references',ref('ConnectReviewList'),
      {...opts,params:[...(opts.params??[]),query('includeOrderIssues',{enum:['1']}),query('before',num)]});
    op('get',base+'order-proofs','Read recent authorized orders and a committed feed boundary',ref('ConnectProofPage'),{...opts,params:[...(opts.params??[]),...search]});
    op('get',base+'order-proofs/{proofId}/revisions/{revision}','Read an immutable authorized revision',ref('ConnectProofRevision'),opts);
  }
  op('get',human+'order-proofs/{proofId}','Read the latest authorized order revision',ref('ConnectProofRevision'),{queryWorkspace:true,params:[location]});
  op('get',human+'order-changes','Resume order revision notifications',ref('ConnectProofChanges'),{queryWorkspace:true,params:[location,query('after',seq),size]});
  op('post',agent+'order-changes','Resume committed revisions for this exporter',ref('ConnectProofChanges'),{body:obj({after:seq,limit:num},[])});
  op('get',agent+'order-proofs/{proofId}/revisions/{revision}/sources/{eventKey}','Inspect one revision-bound source observation. Verified single-record UTF-8 originals are limited to 64 KiB. Other formats return only an authorized record excerpt.',{type:'object',required:['eventKey','receiptId','kind','fields','fieldLineage'],properties:{eventKey:string,receiptId:string,kind:enumOf('original','derived_excerpt'),originalSha256:hash,fileName:{type:'string'},fields:open,fieldLineage:open,locator:{type:'string'},sourceId:string,version:string,observedAt:{type:'string',format:'date-time'},occurredAt:{type:['string','null'],format:'date-time'},originalText:{type:'string',maxLength:65536},reason:string,artifactReceiptId:string}});
  op('get',agent+'order-proofs/{proofId}/revisions/{revision}/artifacts/{receiptId}','Read authorized exact media bytes or a scoped excerpt status',open);
  op('post',human+'order-proofs/{proofId}/associations','Review and correct an observation link',open,{body:obj({...ws,eventKey:string,action:enumOf('link','unlink'),expectedRevision:num,reason:{type:'string',maxLength:1024}}),idempotent:true});
  const time={type:'string',format:'date-time'}, optionalTime={...time,type:['string','null']};
  const nullableString={type:['string','null']}, bool={type:'boolean'};
  const caseActions=enumOf('assign','request_receipt','clarify_mapping','resolve');
  const caseKey={type:'string',minLength:1,maxLength:512},reason={type:'string',minLength:1,maxLength:1024};
  const selected={queryWorkspace:true,params:[location]};
  const proof=human+'order-proofs/{proofId}',pin=proof+'/revisions/{revision}',installation=human+'agent-installations/{installationId}';
  for (const schema of [schemas.ConnectObservationFile,schemas.ConnectSourceSubmission]) schema.properties.firstSeenAt=time;
  Object.assign(schemas.ConnectSourceScope.properties,{
    expectedCheckIntervalSeconds:{type:'integer',minimum:60,maximum:86400},
    expectedDeliveryAfterLabelSeconds:{type:'integer',minimum:60,maximum:31536000},
  });
  schemas.ConnectOperationScope.properties.testedProfile=obj({schema:{const:'packproof.facility-replay/v1'},
    digest:hash,draftId:{type:'string',format:'uuid'},revision:num,examples:{const:3}});
  Object.assign(summary.properties,{locationId:nullableString,displayOrderReference:string,
    matchedSubjects:array(obj({id:string,type:string,namespace:string,sourceId:string}))});
  Object.assign(schemas.ConnectProofRevision.properties,{
    displayOrderReference:string,deliveryCoverage:enumOf('configured','outside_approved_sources','unreported'),
    cartons:array(obj({namespace:string,id:string,lastEventKind:string,lastEventKey:string,occurredAt:optionalTime,observedAt:time,
      deliveryStatus:enumOf('delivered','awaiting_evidence')})),
    changes:array({type:'object',required:['kind','sourceId'],properties:{
      kind:enumOf('added','updated','unlinked','original_attached','historical_evidence_received'),sourceId:string,eventKey:string,
      previousEventKey:string,profileVersion:string,receiptId:string,fields:array(obj({scope:string,field:string,previous:{},current:{}},['scope','field']))}}),
  });
  for(const suffix of ['/sources/{eventKey}','/artifacts/{receiptId}'])
    op('get',pin+suffix,'Open authorized evidence from this pinned revision',open,selected);
  const packetItem=enumOf('source','artifact');
  op('post',pin+'/packet','Download and audit this authorized revision',obj({
    schema:{const:'packproof.order-packet/v1'},exportId:string,proofId:string,revision:num,exportedAt:time,destination:{const:'user_download'},
    projection:ref('ConnectProofRevision'),manifest:array(obj({kind:packetItem,id:string,disposition:enumOf('original','excerpt','omitted'),
      reason:string},['kind','id','disposition'])),contents:array(obj({kind:packetItem,id:string,record:open}))}),selected);
  op('put',installation+'/order-original-access','Set a member’s original access for an installation',
    obj({installationId:string,membershipId:string,allowed:bool}),{body:obj({...ws,membershipId:string,allowed:bool,reason:caseKey})});
  const action=obj({id:string,caseKey,version:num,proofRevision:num,action:caseActions,
    ownerMembershipId:nullableString,actorUserId:string,reason,createdAt:time});
  op('get',proof+'/case-actions','Read the last 100 review actions on this order',obj({items:array(action)}),selected);
  op('post',proof+'/case-actions','Record a version-checked review action',action,{idempotent:true,body:obj({...ws,caseKey,
    action:caseActions,reason,expectedRevision:num,expectedVersion:seq,ownerMembershipId:string},
    ['organizationId','environment','caseKey','action','reason','expectedRevision','expectedVersion'])});
  op('get',installation+'/workspace-access','Check the signed-in person’s guided workspace access',
    obj({canConfigure:bool,...ws,locationId:nullableString,userId:string}),{queryWorkspace:true});
  const step=enumOf('release','pick','pack','weigh','label','handoff','delivery','return');
  const field={type:'string',pattern:'^f(?:[1-9]|[1-5][0-9]|6[0-4])$'};
  op('post',installation+'/facility-setup/suggestions/v1','Request bounded setup suggestions with consent',
    obj({revision:num,requestId:hash,suggestions:array(obj({operation:enumOf('ask_question','map_field','suggest_step','mark_unknown'),
      step,field:nullableString,meaning:string,reason:string}))}),{queryWorkspace:true,
      body:obj({draftId:{type:'string',format:'uuid'},revision:num,consent:{const:true},steps:{...array(step,8),minItems:1,uniqueItems:true},
        fields:{...array(obj({handle:field,label:enumOf('Shipped At','Carton','Weight','Unit','Order','Tracking','Delivered At','Other'),
          type:enumOf('text','number','datetime')}),64),minItems:1}})});
  const review=installation+'/facility-setup/reviews/v1';
  op('post',review,'Record a setup suggestion decision without transmitting sample values',open,{queryWorkspace:true,status:204,
    body:obj({draftId:{type:'string',format:'uuid'},revision:num,requestId:hash,index:{type:'integer',minimum:0,maximum:5},
      decision:enumOf('accepted','edited','rejected')})});
  api.paths[review].post.responses[204]={description:'Review recorded.'};
  op('post',agent+'order-workspace/withdraw','Withdraw the matching pending setup approval',obj({withdrawn:bool}),{body:obj({scopeDigest:hash})});
  op('post',agent+'order-workspace/source-health','Record an installed collector source check',obj({accepted:bool}),
    {body:obj({scopeDigest:hash,sourceId:string,generation:num,checkedAt:time,lastVerifiedReadAt:optionalTime,state:enumOf('current','unreadable')})});
  op('get',human+'order-source-health','Read delayed sources and overdue cartons within the authorized scope',obj({
    asOf:time,limited:bool,incidents:array(obj({installationId:string,sourceId:string,generation:num,displayName:string,
      state:enumOf('unreadable','delayed'),lastVerifiedReadAt:optionalTime,nextCheckAt:optionalTime,
      affectedOrders:array(obj({proofId:string,orderReference:string}))})),
    overdue:array(obj({proofId:string,orderReference:string,id:string,namespace:string,deadline:time}))
  }),selected);
  api['x-packproof-order-workspace']={version:'packproof.order-workspace/v1',activation:'PACKPROOF_ORDER_WORKSPACE_ENABLED',guide:'docs/ORDER_WORKSPACE_API.md',originalMaxBytes:3145728,feed:'poll after nextCursor; sequences can have gaps across authorization scopes'};
}
