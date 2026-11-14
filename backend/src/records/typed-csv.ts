import {parseCsv} from './csv.js';

/** Shared raw-cell parsing for typed rows and exporter control metadata. */
export function parseTypedCsvRecords(content:string):string[][] {
 const source=content.replace(/^\uFEFF/,'');
 const candidates=([',',';','\t'] as const).map(delimiter=>{try{const records=parseCsv(source,delimiter);return {records,score:records[0]?.length??0};}catch(error){return {records:null,score:-1,error};}}).sort((a,b)=>b.score-a.score);
 if(!candidates[0].records)throw candidates[0].error;
 return candidates[0].records;
}
