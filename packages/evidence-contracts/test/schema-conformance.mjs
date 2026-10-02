import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
/** Test-only evaluator for this repository's declared JSON Schema vocabulary.
 * Unknown assertion keywords fail closed; never used to validate production input. */
export function conforms(value,schema) {
  const allowed=new Set(['$schema','$id','$ref','description','type','required','properties','additionalProperties','const','enum','pattern','minLength','maxLength','minimum','maximum','minItems','maxItems','items','format','anyOf','allOf','not','if','then','else']);
  for(const key of Object.keys(schema))if(!allowed.has(key))throw new Error(`Unhandled schema test keyword ${key}`);
  if(schema.$ref&&!conforms(value,readSchema(schema.$ref.replace(/\.schema\.json$/,''))))return false;
  if(schema.const!==undefined&&!isDeepStrictEqual(value,schema.const))return false;
  if(schema.enum&&!schema.enum.some(v=>isDeepStrictEqual(value,v)))return false;
  if(schema.anyOf&&!schema.anyOf.some(s=>conforms(value,s)))return false;
  if(schema.allOf&&!schema.allOf.every(s=>conforms(value,s)))return false;
  if(schema.not&&conforms(value,schema.not))return false;
  if(schema.if){const follow=conforms(value,schema.if)?schema.then:schema.else;if(follow&&!conforms(value,follow))return false;}
  const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
  if(schema.type&&![schema.type].flat().some(t=>t==='integer'?Number.isSafeInteger(value):type(value)===t))return false;
  if(typeof value==='string'){
    if(schema.minLength!==undefined&&[...value].length<schema.minLength||schema.maxLength!==undefined&&[...value].length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern).test(value))return false;
    if(schema.format==='date-time'&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))return false;
  }
  if(typeof value==='number'&&(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))return false;
  if(Array.isArray(value)&&(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems||schema.items&&!value.every(v=>conforms(v,schema.items))))return false;
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
    if(schema.required&&!schema.required.every(k=>Object.hasOwn(value,k)))return false;
    for(const key of Object.keys(value)){if(schema.properties?.[key]){if(!conforms(value[key],schema.properties[key]))return false;}else if(schema.additionalProperties===false)return false;}
  }
  return true;
}
export const readSchema=name=>JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`,import.meta.url)));
