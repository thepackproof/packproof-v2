import {useState} from 'react';
import type {PackProofApi} from '../api/client';
import {useWorkflowCommand,useWorkflowData} from './workflow';
interface Rule {key:string;stage:string;title:string;acceptedEvidenceTypes:string[];gracePeriodMs:number}
interface Definition {name:string;description:string|null;rules:Rule[]}
interface Template {templateId:string;version:number;definitionSha256:string;definition:Definition}
const stages=['preparation','loading','handoff','delivery','return','receiving','customer_pickup'];
const categories=[['SOURCE_ARTIFACT','Existing source file'],['PACKING_CAPTURE','Packing capture'],['FULFILLMENT_CAPTURE','Fulfillment capture'],['RECEIPT_CAPTURE','Receipt capture'],['ASSET_CAPTURE','Asset capture'],['SELLER_EVIDENCE','Seller evidence']];
const initialRule=(n:number):Rule=>({key:'requirement_'+n,stage:'preparation',title:'',acceptedEvidenceTypes:['SOURCE_ARTIFACT'],gracePeriodMs:0});
export function RequirementTemplates({api,proofId,organizationId,environment,recordRevision,entities,onUpdated}:{api:PackProofApi;proofId:string;organizationId:string;environment:string;recordRevision:number;entities:Array<{id:string;label:string}>;onUpdated:()=>void}){
 const query=new URLSearchParams({organizationId,environment}).toString(),boundary=organizationId+'.'+environment+'.'+proofId;
 const [refresh,setRefresh]=useState(0),[selected,setSelected]=useState(''),[subjectId,setSubjectId]=useState(proofId),[dueAt,setDueAt]=useState(''),[reason,setReason]=useState(''),[reviewed,setReviewed]=useState(false);
 const [name,setName]=useState(''),[rules,setRules]=useState<Rule[]>([initialRule(1)]),[base,setBase]=useState<Template|null>(null),[notice,setNotice]=useState('');
 const catalog=useWorkflowData<{templates:Template[]}>(api,'/requirement-templates?'+query,refresh),command=useWorkflowCommand(api,boundary);
 const templates=catalog.data?.templates??[],template=templates.find(t=>t.templateId+'@'+t.version===selected);
 function changed(){setReviewed(false);setNotice('');}
 function editRule(index:number,patch:Partial<Rule>){setRules(values=>values.map((rule,i)=>i===index?{...rule,...patch}:rule));}
 async function publish(){
  const definition={name:name.trim(),description:base?.definition.description??null,rules:rules.map(rule=>({...rule,title:rule.title.trim()}))};
  const saved=await command.run<Template>('/requirement-templates?'+query,{templateId:base?.templateId,expectedVersion:base?.version??0,definition});
  if(saved){setSelected(saved.templateId+'@'+saved.version);setBase(saved);setRefresh(n=>n+1);setReviewed(false);setNotice('Saved '+saved.definition.name+', version '+saved.version+'. Review it before assignment.');}
 }
 async function assign(){
  if(!template||!reviewed)return;
  const saved=await command.run('/'+encodeURIComponent(proofId)+'/requirement-template-assignments?'+query,{templateId:template.templateId,version:template.version,definitionSha256:template.definitionSha256,subjectId,dueAt:dueAt.trim()||null,reason:reason.trim()},{'If-Match':'"'+recordRevision+'"'});
  if(saved){setReviewed(false);setReason('');setNotice('Assigned version '+template.version+' to this record. Existing requirements remain in its history.');onUpdated();}
 }
 return <details className="records-panel records-workflow-action"><summary>Manage reusable evidence requirements</summary>
  <p>Publish a reusable set, then review the exact version for a shipment or item. Later versions preserve earlier assignments. An existing source file satisfies a file category; it does not establish what happened physically.</p>
  {catalog.loading&&<p role="status">Loading requirement versions…</p>}{catalog.error&&<p role="alert">{catalog.error}</p>}
  <label>Published requirement set<select value={selected} onChange={e=>{setSelected(e.target.value);changed();}}><option value="">Choose a version to review</option>{templates.map(t=><option key={t.templateId+'@'+t.version} value={t.templateId+'@'+t.version}>{t.definition.name} · version {t.version} · {t.templateId.slice(-6)}</option>)}</select></label>
  {template&&<><h3>{template.definition.name} · version {template.version}</h3><ul>{template.definition.rules.map(rule=><li key={rule.key}>{rule.title} · {rule.stage.replaceAll('_',' ')} · {rule.acceptedEvidenceTypes.map(type=>categories.find(c=>c[0]===type)?.[1]??type).join(' or ')}{rule.gracePeriodMs>0?' · '+rule.gracePeriodMs/3600000+' hours grace':''}</li>)}</ul>
   <details><summary>Version identity</summary><code>{template.definitionSha256}</code></details>
   <button className="records-button secondary" disabled={command.busy} onClick={()=>{setBase(template);setName(template.definition.name);setRules(template.definition.rules.map(rule=>({...rule,acceptedEvidenceTypes:[...rule.acceptedEvidenceTypes]})));setNotice('Edit the fields below to publish a new version.');}}>Use this version as an editing starting point</button>
   <label>Apply requirements to<select value={subjectId} onChange={e=>{setSubjectId(e.target.value);changed();}}>{entities.map(entity=><option key={entity.id} value={entity.id}>{entity.label}</option>)}</select></label>
   <label>Due time, with time zone (optional)<input placeholder="2026-11-05T16:00:00-05:00" value={dueAt} onChange={e=>{setDueAt(e.target.value);changed();}}/></label>
   <label>Assignment reason<textarea maxLength={1000} value={reason} onChange={e=>{setReason(e.target.value);changed();}}/></label>
   <label><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>I reviewed this version, the selected entity, and the due time.</label>
   <button className="records-button" disabled={command.busy||!reviewed||!reason.trim()} onClick={()=>void assign()}>Assign reviewed requirements</button></>}
  <details><summary>{base?'Publish the next version of '+base.definition.name:'Create a reusable requirement set'}</summary>
   {base&&<button className="records-text-button" onClick={()=>{setBase(null);setName('');setRules([initialRule(1)]);}}>Start a separate requirement set</button>}
   <label>Requirement set name<input maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
   {rules.map((rule,index)=><fieldset key={rule.key}><legend>Requirement {index+1}</legend>
    <label>Requirement title<input maxLength={200} value={rule.title} onChange={e=>editRule(index,{title:e.target.value})}/></label>
    <label>Shipping stage<select value={rule.stage} onChange={e=>editRule(index,{stage:e.target.value})}>{stages.map(stage=><option key={stage} value={stage}>{stage.replaceAll('_',' ')}</option>)}</select></label>
    <fieldset><legend>Accepted evidence categories</legend>{categories.map(([value,label])=><label key={value}><input type="checkbox" checked={rule.acceptedEvidenceTypes.includes(value)} onChange={e=>editRule(index,{acceptedEvidenceTypes:e.target.checked?[...rule.acceptedEvidenceTypes,value]:rule.acceptedEvidenceTypes.filter(type=>type!==value)})}/>{label}</label>)}</fieldset>
    <label>Grace period in hours<input type="number" min={0} max={720} step={1} value={rule.gracePeriodMs/3600000} onChange={e=>editRule(index,{gracePeriodMs:Number(e.target.value)*3600000})}/></label>
    {rules.length>1&&<button className="records-text-button" onClick={()=>setRules(values=>values.filter((_,i)=>i!==index))}>Remove requirement {index+1}</button>}</fieldset>)}
   <button className="records-button secondary" disabled={command.busy||rules.length>=20} onClick={()=>setRules(values=>[...values,initialRule(Math.max(...values.map(rule=>Number(rule.key.split('_').at(-1))||0))+1)])}>Add requirement</button>
   <button className="records-button" disabled={command.busy||!name.trim()||rules.some(rule=>!rule.title.trim()||!rule.acceptedEvidenceTypes.length||!Number.isInteger(rule.gracePeriodMs)||rule.gracePeriodMs<0||rule.gracePeriodMs>2592000000)} onClick={()=>void publish()}>Publish {base?'new version':'requirement set'}</button>
  </details>{command.error&&<p role="alert" className="records-error-text">{command.error}</p>}{notice&&<p role="status">{notice}</p>}
 </details>;
}
