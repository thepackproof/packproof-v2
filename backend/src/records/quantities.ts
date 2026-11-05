import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';
import {textField} from '../platform/tenants.js';
export const QUANTITY_RULE='packproof.quantity-comparison/v1';
type Rational={n:bigint;d:bigint};
type Unit={dimension:string;base:string;n:bigint;d:bigint};
const units:Record<string,Unit>={
 each:{dimension:'count',base:'each',n:1n,d:1n},dozen:{dimension:'count',base:'each',n:12n,d:1n},
 kg:{dimension:'mass',base:'kg',n:1n,d:1n},g:{dimension:'mass',base:'kg',n:1n,d:1000n},lb:{dimension:'mass',base:'kg',n:45359237n,d:100000000n},oz:{dimension:'mass',base:'kg',n:45359237n,d:1600000000n},
 m:{dimension:'length',base:'m',n:1n,d:1n},cm:{dimension:'length',base:'m',n:1n,d:100n},mm:{dimension:'length',base:'m',n:1n,d:1000n},in:{dimension:'length',base:'m',n:127n,d:5000n},ft:{dimension:'length',base:'m',n:381n,d:1250n},
 L:{dimension:'volume',base:'L',n:1n,d:1n},mL:{dimension:'volume',base:'L',n:1n,d:1000n},
};
export interface Quantity {amount:string;unit:string}
export interface QuantitySource {system:string;reference:string;reportedAt:string;payloadSha256:string|null}
export interface QuantityAssertion {quantity:Quantity;source:QuantitySource}
export interface QuantityTolerance {absolute:Quantity|null;relativePpm:number}
export interface QuantityEvaluation {ruleVersion:typeof QUANTITY_RULE;outcome:'within_tolerance'|'different'|'not_comparable';baseUnit:string|null;absoluteDifference:{numerator:string;denominator:string}|null;allowedDifference:{numerator:string;denominator:string}|null;reason:string;physicalCondition:'not_established'}
const bad=(message:string)=>new DomainError('INVALID_QUANTITY',message,400);
function decimal(value:unknown):Rational {
 if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,9})?$/.test(value))throw bad('Use a nonnegative decimal string with up to twelve whole and nine fractional digits. Exponents and locale separators are not inferred.');
 const [whole,fraction='']=value.split('.');return {n:BigInt(whole+fraction),d:10n**BigInt(fraction.length)};
}
export function quantity(input:unknown):Quantity {const b=strictBody(input,['amount','unit']);decimal(b.amount);return {amount:b.amount as string,unit:textField(b.unit,'unit',30)};}
export function quantitySource(input:unknown):QuantitySource {
 const b=strictBody(input,['system','reference','reportedAt','payloadSha256']);
 if(typeof b.reportedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(b.reportedAt)||!Number.isFinite(Date.parse(b.reportedAt)))throw bad('Each quantity assertion requires its source-reported time with an explicit time zone.');
 if(b.payloadSha256!=null&&(typeof b.payloadSha256!=='string'||!/^[a-f0-9]{64}$/.test(b.payloadSha256)))throw bad('A supplied source payload digest must be SHA-256.');
 return {system:textField(b.system,'system',100),reference:textField(b.reference,'reference',200),reportedAt:new Date(b.reportedAt).toISOString(),payloadSha256:(b.payloadSha256 as string)??null};
}
function assertion(input:unknown):QuantityAssertion {const b=strictBody(input,['quantity','source']);return {quantity:quantity(b.quantity),source:quantitySource(b.source)};}
function tolerance(input:unknown):QuantityTolerance {const b=input==null?{}:strictBody(input,['absolute','relativePpm']),ppm=b.relativePpm??0;if(!Number.isInteger(ppm)||Number(ppm)<0||Number(ppm)>1000000)throw bad('Relative tolerance must be an integer from zero to one million parts per million.');return {absolute:b.absolute==null?null:quantity(b.absolute),relativePpm:Number(ppm)};}
const add=(a:Rational,b:Rational):Rational=>({n:a.n*b.d+b.n*a.d,d:a.d*b.d});
const difference=(a:Rational,b:Rational):Rational=>{const n=a.n*b.d-b.n*a.d;return {n:n<0n?-n:n,d:a.d*b.d};};
const compare=(a:Rational,b:Rational)=>a.n*b.d-b.n*a.d;
function base(q:Quantity):{unit:Unit;value:Rational}|null {if(!Object.hasOwn(units,q.unit))return null;const unit=units[q.unit],value=decimal(q.amount);return {unit,value:{n:value.n*unit.n,d:value.d*unit.d}};}
function reduced(value:Rational){let a=value.n,b=value.d;while(b){const rest=a%b;a=b;b=rest;}return {numerator:String(value.n/(a||1n)),denominator:String(value.d/(a||1n))};}
export function evaluateQuantities(expected:Quantity,observed:Quantity[],policy:QuantityTolerance={absolute:null,relativePpm:0}):QuantityEvaluation {
 const e=base(expected),values=observed.map(base),absolute=policy.absolute?base(policy.absolute):null,common={ruleVersion:QUANTITY_RULE,physicalCondition:'not_established'} as const;
 if(!e||values.some(v=>!v||v.unit.dimension!==e.unit.dimension)||(policy.absolute&&(!absolute||absolute.unit.dimension!==e.unit.dimension)))return {...common,outcome:'not_comparable',baseUnit:null,absoluteDifference:null,allowedDifference:null,reason:'A unit is unknown or the dimensions differ. Product-specific pack sizes, currencies, and volume-to-mass conversions are never guessed.'};
 let sum:Rational={n:0n,d:1n};for(const value of values)sum=add(sum,value!.value);
 const delta=difference(e.value,sum),relative={n:e.value.n*BigInt(policy.relativePpm),d:e.value.d*1000000n},limit=absolute&&compare(absolute.value,relative)>0?absolute.value:relative;
 return {...common,outcome:compare(delta,limit)<=0?'within_tolerance':'different',baseUnit:e.unit.base,absoluteDifference:reduced(delta),allowedDifference:reduced(limit),reason:'Exact rational unit conversion; absolute difference is compared with the greater of the declared absolute and relative tolerances. Quantities remain source assertions.'};
}
export function normalizeQuantityComparison(input:unknown){const b=strictBody(input,['schema','expected','observed','tolerance']);if(b.schema!==QUANTITY_RULE)throw bad('Use the supported quantity comparison profile.');const expected=assertion(b.expected),observed=assertion(b.observed),policy=tolerance(b.tolerance);return {schema:QUANTITY_RULE,expected,observed,tolerance:policy,evaluation:evaluateQuantities(expected.quantity,[observed.quantity],policy)};}
export function normalizeItemAllocation(input:unknown){
 const b=strictBody(input,['schema','sku','description','ordered','allocations','tolerance']);if(b.schema!=='packproof.item-allocation/v1')throw bad('Use the supported item allocation profile.');if(!Array.isArray(b.allocations)||b.allocations.length>50)throw bad('At most fifty explicitly identified handling-unit allocations are supported per item version.');
 const ordered=assertion(b.ordered),seen=new Set<string>(),allocations=b.allocations.map(raw=>{const row=strictBody(raw,['handlingUnitId','quantity','source']),id=textField(row.handlingUnitId,'handlingUnitId');if(seen.has(id))throw bad('Combine each item version into one explicit allocation per handling unit.');seen.add(id);return {handlingUnitId:id,quantity:quantity(row.quantity),source:quantitySource(row.source)};}),policy=tolerance(b.tolerance);
 return {schema:'packproof.item-allocation/v1' as const,sku:b.sku==null?null:textField(b.sku,'sku',200),description:b.description==null?null:textField(b.description,'description',200),ordered,allocations,tolerance:policy,evaluation:evaluateQuantities(ordered.quantity,allocations.map(a=>a.quantity),policy)};
}
