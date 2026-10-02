#!/usr/bin/env node
/** Dependency-free generator for this API's deliberately small JSON Schema type vocabulary.
 * Source: backend/rnd-openapi.json and the referenced shared JSON Schemas.
 * This generates transport/types, not cryptographic or server policy validation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const specPath=path.join(root,'backend/rnd-openapi.json');
const contractRoot=path.join(root,'packages/evidence-contracts/schemas');
const files=new Map();
async function read(file){if(!files.has(file))files.set(file,await readFile(file,'utf8'));return JSON.parse(files.get(file));}
const spec=await read(specPath),schemas={...spec.components.schemas},external=new Map();
const identifier=value=>value.replace(/(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g,(_,p,c)=>c.toUpperCase());
async function collect(node,base){
 if(!node||typeof node!=='object')return;
 if(node.$ref&&!node.$ref.startsWith('#/')){
  if(node.$ref.includes('#')||/^[a-z]+:/i.test(node.$ref))throw new Error(`Only local shared schemas are permitted: ${node.$ref}`);
  const target=path.resolve(path.dirname(base),node.$ref);
  if(!target.startsWith(contractRoot+path.sep))throw new Error('Reference outside shared schema directory');
  if(!external.has(target)){
   const name='Shared'+identifier(path.basename(target,'.schema.json'));external.set(target,name);
   const schema=await read(target);schemas[name]=schema;await collect(schema,target);
  }
  node.$ref='#/components/schemas/'+external.get(target);
 }
 for(const [key,value] of Object.entries(node))if(key!=='$ref')await collect(value,base);
}
await collect(spec,specPath);
// collect() mutates reference targets and installs the external aliases in schemas.
for(const [name,schema] of Object.entries(spec.components.schemas))schemas[name]=schema;
const js=value=>JSON.stringify(value);
function type(schema){
 if(schema===true||schema===undefined)return 'unknown';if(schema===false)return 'never';
 if(schema.$ref){const prefix='#/components/schemas/';if(!schema.$ref.startsWith(prefix)||!schemas[schema.$ref.slice(prefix.length)])throw new Error(`Unknown schema ${schema.$ref}`);return schema.$ref.slice(prefix.length);}
 if(Object.hasOwn(schema,'const'))return JSON.stringify(schema.const);
 if(schema.enum)return schema.enum.map(js).join(' | ');
 if(schema.oneOf||schema.anyOf)return (schema.oneOf??schema.anyOf).map(s=>'('+type(s)+')').join(' | ');
 const structural=schema.allOf?.filter(s=>!s.if);
 if(structural?.length)return [type({...schema,allOf:undefined}),...structural.map(type)].filter(t=>t!=='unknown').map(t=>'('+t+')').join(' & ')||'unknown';
 if(Array.isArray(schema.type))return schema.type.map(t=>type({...schema,type:t})).join(' | ');
 switch(schema.type){
  case 'null':return 'null';case 'string':return 'string';case 'number':case 'integer':return 'number';case 'boolean':return 'boolean';
  case 'array':{
   if(schema.minItems===schema.maxItems&&schema.maxItems<=64)return '['+Array.from({length:schema.maxItems},()=>type(schema.items)).join(', ')+']';
   return 'Array<'+type(schema.items)+'>';
  }
  case 'object':{
   const props=Object.entries(schema.properties??{}).map(([k,v])=>`${js(k)}${schema.required?.includes(k)?'':'?'}: ${type(v)};`);
   if(schema.additionalProperties!==false)props.push(`[key: string]: ${typeof schema.additionalProperties==='object'?type(schema.additionalProperties):'unknown'};`);
   return props.length?'{ '+props.join(' ')+' }':'Record<string, never>';
  }
  case undefined:if(schema.if)return 'unknown';break;
 }
 throw new Error(`Unsupported type generation: ${JSON.stringify(schema)}`);
}
const routes={},operationTypes=[];
for(const [template,item] of Object.entries(spec.paths))for(const [method,operation] of Object.entries(item)){
 if(!['get','post','put','patch','delete','head'].includes(method))throw new Error('Unsupported Path Item field '+method);
 const id=operation.operationId;if(!id||routes[id])throw new Error('Missing/duplicate operationId');
 const parameters=operation.parameters??[],pathParams=parameters.filter(p=>p.in==='path'),query=parameters.filter(p=>p.in==='query');
 const idempotent=parameters.some(p=>p.in==='header'&&p.name==='Idempotency-Key'&&p.required);
 const body=operation.requestBody?.content?.['application/json']?.schema;
 const response=Object.entries(operation.responses).find(([code])=>/^2\d\d$/.test(code))?.[1];
 if(!response)throw new Error('Operation lacks success response');
 const binary=!response.content?.['application/json'];
 routes[id]={method:method.toUpperCase(),template,pathParameters:Object.fromEntries(pathParams.map(p=>[p.name,p.schema])),queryParameters:Object.fromEntries(query.map(p=>[p.name,p.schema])),idempotent,body:Boolean(body),binary};
 const input=[];
 if(pathParams.length)input.push('path: { '+pathParams.map(p=>`${js(p.name)}: ${type(p.schema)};`).join(' ')+' };');
 if(query.length)input.push('query?: { '+query.map(p=>`${js(p.name)}${p.required?'':'?'}: ${type(p.schema)};`).join(' ')+' };');
 if(body)input.push(`body: ${type(body)};`);
 if(idempotent)input.push('idempotencyKey: string;');
 input.push('signal?: AbortSignal;');
 operationTypes.push(`${js(id)}: { input: { ${input.join(' ')} }; output: ${binary?'ArrayBuffer':type(response.content['application/json'].schema)}; };`);
}
const digest=createHash('sha256');
for(const [file,bytes] of [...files].sort(([a],[b])=>a.localeCompare(b)))digest.update(path.relative(root,file)).update('\0').update(bytes).update('\0');
digest.update(await readFile(fileURLToPath(import.meta.url)));
const hash=digest.digest('hex');
const banner=`// GENERATED by scripts/generate-rnd-client.mjs; DO NOT EDIT.\n// Input + generator SHA-256: ${hash}\n`;
const runtime=banner+`export const RND_API_VERSION = ${js(spec.info.version)};
export const RND_API_SCHEMA_DIGEST = ${js(hash)};
const routes = ${JSON.stringify(routes,null,2)};
export const RND_OPERATIONS = Object.freeze(Object.keys(routes));
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function validateParameter(value,schema,name) {
 if(schema.type==='integer') {
  if(!Number.isSafeInteger(value)||value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)throw new TypeError('Invalid '+name);
 } else if(typeof value!=='string'||schema.pattern&&!new RegExp(schema.pattern).test(value)||schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength)throw new TypeError('Invalid '+name);
 if(value==='.'||value==='..')throw new TypeError('Invalid '+name);
 return String(value);
}
/** Pure transport builder. Body/schema/cryptographic policy remains server-authoritative. */
export function buildRndRequest(operationId,input={}) {
 if(!own(routes,operationId))throw new TypeError('Unknown R&D operation');
 const route=routes[operationId],headers={Accept:route.binary?'application/octet-stream':'application/json'};
 for(const key of Object.keys(input))if(!['path','query','body','idempotencyKey','signal'].includes(key))throw new TypeError('Unexpected request field: '+key);
 for(const key of Object.keys(input.path??{}))if(!own(route.pathParameters,key))throw new TypeError('Unexpected path parameter');
 let pathname=route.template;
 for(const [key,schema] of Object.entries(route.pathParameters))pathname=pathname.replace('{'+key+'}',encodeURIComponent(validateParameter(input.path?.[key],schema,key)));
 const query=new URLSearchParams();
 for(const [key,value] of Object.entries(input.query??{})){
  if(!own(route.queryParameters,key))throw new TypeError('Unexpected query parameter');
  if(value!==undefined)query.set(key,validateParameter(value,route.queryParameters[key],key));
 }
 if(query.size)pathname+='?'+query.toString();
 if(route.idempotent)headers['Idempotency-Key']=validateParameter(input.idempotencyKey,{type:'string',pattern:'^[a-zA-Z0-9_:./-]{1,180}$'},'Idempotency-Key');
 else if(input.idempotencyKey!==undefined)throw new TypeError('Operation does not accept an idempotency key');
 if(route.body){if(input.body===undefined)throw new TypeError('Request body required');headers['Content-Type']='application/json';}
 else if(input.body!==undefined)throw new TypeError('Operation does not accept a request body');
 return {path:pathname,method:route.method,body:input.body,headers};
}
export class RndApiError extends Error {
 constructor(status,code,message,details){super(message);this.name='RndApiError';this.status=status;this.code=code;this.details=details;}
}
/** No token storage, background retry, refresh, or account selection is performed. */
export function createRndClient({baseUrl='',fetch:transport=globalThis.fetch,headers:configuredHeaders,credentials}={}) {
 if(typeof transport!=='function')throw new TypeError('A fetch implementation is required');
 if(typeof baseUrl!=='string'||/[?#]/.test(baseUrl))throw new TypeError('baseUrl must not include query or fragment');
 const base=baseUrl.replace(/\\/$/,'');
 const request=async(operationId,input={})=>{
  const built=buildRndRequest(operationId,input);
  const initial=typeof configuredHeaders==='function'?await configuredHeaders():configuredHeaders;
  const headers=new Headers(initial);
  for(const [name,value] of Object.entries(built.headers))headers.set(name,value);
  const response=await transport(base+built.path,{method:built.method,headers,body:built.body===undefined?undefined:JSON.stringify(built.body),signal:input.signal,...(credentials===undefined?{}:{credentials}),redirect:'error',cache:'no-store'});
  if(!response.ok){let details;try{details=await response.json();}catch{details=null;}throw new RndApiError(response.status,details?.error?.code??'RND_HTTP_ERROR',details?.error?.message??('Research request failed ('+response.status+')'),details);}
  return routes[operationId].binary?response.arrayBuffer():response.json();
 };
 return Object.freeze({request,...Object.fromEntries(RND_OPERATIONS.map(id=>[id,input=>request(id,input)]))});
}
`;
const declarations=banner+`export const RND_API_VERSION: ${js(spec.info.version)};
export const RND_API_SCHEMA_DIGEST: string;
${Object.entries(schemas).sort(([a],[b])=>a.localeCompare(b)).map(([name,schema])=>`export type ${name} = ${type(schema)};`).join('\n')}
export interface RndOperationMap {
 ${operationTypes.join('\n ')}
}
export type RndOperationId = keyof RndOperationMap;
export type RndInput<K extends RndOperationId> = RndOperationMap[K]['input'];
export type RndOutput<K extends RndOperationId> = RndOperationMap[K]['output'];
export const RND_OPERATIONS: readonly RndOperationId[];
export interface BuiltRndRequest { path: string; method: string; body: unknown; headers: Record<string,string>; }
export function buildRndRequest<K extends RndOperationId>(operationId: K,input: RndInput<K>): BuiltRndRequest;
export class RndApiError extends Error { constructor(status:number,code:string,message:string,details:unknown); status:number;code:string;details:unknown; }
export type RndClient = { request<K extends RndOperationId>(operationId:K,input:RndInput<K>):Promise<RndOutput<K>> } & { [K in RndOperationId]: (input:RndInput<K>)=>Promise<RndOutput<K>> };
export interface RndClientOptions {baseUrl?:string;fetch?:typeof globalThis.fetch;headers?:HeadersInit|(()=>HeadersInit|Promise<HeadersInit>);credentials?:RequestCredentials;}
export function createRndClient(options?:RndClientOptions):RndClient;
`;
const outputs=[['packages/evidence-contracts/generated-client.mjs',runtime],['packages/evidence-contracts/generated-client.d.mts',declarations]];
if(process.argv.includes('--check')){
 let drift=false;
 for(const [file,content] of outputs){let actual;try{actual=await readFile(path.join(root,file),'utf8');}catch{}if(actual!==content){console.error('Generated R&D client drift: '+file);drift=true;}}
 if(drift)process.exitCode=1;else console.log(`R&D client is current (${Object.keys(routes).length} operations).`);
}else{for(const [file,content] of outputs)await writeFile(path.join(root,file),content);console.log(`Generated ${Object.keys(routes).length} R&D operations.`);}
