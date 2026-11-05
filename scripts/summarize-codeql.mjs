import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';

// Print diagnostic metadata only. Never execute report content or emit source
// snippets, environment values, credentials or repository file contents.
const directory=process.argv[2]??'codeql-results';
const results=[];
for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sarif')).sort()){
 const report=JSON.parse(await readFile(path.join(directory,name),'utf8'));
 for(const run of report.runs??[]){
  const rules=[...(run.tool?.driver?.rules??[]),...(run.tool?.extensions??[]).flatMap(extension=>extension.rules??[])];
  const byId=new Map(rules.map(rule=>[rule.id,rule]));
  const location=value=>({path:value?.physicalLocation?.artifactLocation?.uri??null,line:value?.physicalLocation?.region?.startLine??null,endLine:value?.physicalLocation?.region?.endLine??null});
  for(const result of run.results??[]){
   const rule=byId.get(result.ruleId)??rules[result.ruleIndex];
   results.push({ruleId:result.ruleId??rule?.id??null,level:result.level??rule?.defaultConfiguration?.level??null,
    securitySeverity:rule?.properties?.['security-severity']??null,message:String(result.message?.text??'').slice(0,2000),
    locations:(result.locations??[]).map(location),
    flow:(result.codeFlows??[]).flatMap(flow=>(flow.threadFlows??[]).flatMap(thread=>(thread.locations??[]).map(item=>location(item.location)))).slice(0,40)});
  }
 }
}
const security=results.filter(result=>Number(result.securitySeverity)>=7);
const selected=security.length?security:results;
console.log(JSON.stringify({totalResults:results.length,highSeverityResults:security.length,truncated:selected.length>200,results:selected.slice(0,200)}));
