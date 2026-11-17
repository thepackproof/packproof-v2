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
  const search = [query('q',string),size];
  const schemas = api.components.schemas;
  const line = {lineId:string,sku:{type:['string','null']},unit:{type:['string','null']}};
  for(const field of ['orderedQuantity','pickedQuantity','packedQuantity','shippedQuantity','returnedQuantity','cancelledQuantity'])line[field]={type:['string','null'],pattern:'^(?:[0-9]{1,18}(?:\\.[0-9]{1,9})?)?$'};
  schemas.ConnectOrderLine=obj(line,['lineId']);
  schemas.ConnectProjectedOrderLine=obj({...line,
    orderedMinusShippedQuantity:{type:'string',pattern:'^-?[0-9]+(?:\\.[0-9]{1,9})?$',description:'Exact ordered minus shipped. Present when both source quantities have the same unambiguous unit.'},
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
  schemas.ConnectProofPage=obj({orders:array(obj({...version,orderReference:string,updatedAt:{type:'string',format:'date-time'}})),cursor:seq});
  schemas.ConnectProofChanges=obj({changes:array(obj({...version,sequence:seq})),nextCursor:seq,hasMore:{type:'boolean'}});
  schemas.ConnectScopeSession={type:'object',required:['state','scopeDigest','approvalPath'],properties:{id:string,state:enumOf('draft','pending','active','denied','superseded','expired'),scopeDigest:{anyOf:[hash,{type:'null'}]},approvalPath:{type:['string','null']},scope:ref('ConnectOperationScope'),deviceName:string,offlineWindowSeconds:seq}};
  schemas.ConnectObservationReceipt={type:'object',properties:{receiptId:string,state:enumOf('accepted','pending'),proofs:array(obj(version)),originalSha256:hash,issues:array(string),code:string},required:['receiptId','state','proofs','originalSha256']};
  schemas.ConnectReviewList=obj({items:array(open),hasMore:{type:'boolean'}});
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
    op('get',base+'order-attention','List unresolved order references',ref('ConnectReviewList'),opts);
    op('get',base+'order-proofs','Read recent authorized orders and a committed feed boundary',ref('ConnectProofPage'),{...opts,params:[...(opts.params??[]),...search]});
    op('get',base+'order-proofs/{proofId}/revisions/{revision}','Read an immutable authorized revision',ref('ConnectProofRevision'),opts);
  }
  op('get',human+'order-proofs/{proofId}','Read the latest authorized order revision',ref('ConnectProofRevision'),{queryWorkspace:true,params:[location]});
  op('get',human+'order-changes','Resume order revision notifications',ref('ConnectProofChanges'),{queryWorkspace:true,params:[location,query('after',seq),size]});
  op('post',agent+'order-changes','Resume committed revisions for this exporter',ref('ConnectProofChanges'),{body:obj({after:seq,limit:num},[])});
  op('get',agent+'order-proofs/{proofId}/revisions/{revision}/artifacts/{receiptId}','Read authorized exact media bytes or a scoped excerpt status',open);
  op('post',human+'order-proofs/{proofId}/associations','Review and correct an observation link',open,{body:obj({...ws,eventKey:string,action:enumOf('link','unlink'),expectedRevision:num,reason:{type:'string',maxLength:1024}}),idempotent:true});
  api['x-packproof-order-workspace']={version:'packproof.order-workspace/v1',activation:'PACKPROOF_ORDER_WORKSPACE_ENABLED',guide:'docs/ORDER_WORKSPACE_API.md',originalMaxBytes:3145728,feed:'poll after nextCursor; sequences can have gaps across authorization scopes'};
}
