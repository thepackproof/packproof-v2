export type Scalar = string | number | boolean | null;
export type Metric = {key:string;label:string;value:number|null;previous:number|null;unit?:string;status:string;note?:string;href?:string};
export type Action = {id:string;label:string;path:string;method?:string;risk?:string;confirmation:string;body?:Record<string,unknown>;fields?:Array<{key:string;label:string;type:string;required?:boolean}>};
export type Section = {title:string;description?:string;updatedAt:string;metrics:Metric[];columns:Array<{key:string;label:string}>;rows:Array<Record<string,Scalar>>;pagination?:{page:number;pageSize:number;total:number};notices?:string[];actions?:Action[]};
export type Overview = {updatedAt:string;environment?:string;range:{from:string;to:string;previousFrom:string;previousTo:string};metrics:Metric[];health:Array<{key:string;label:string;status:string;detail:string;checkedAt:string}>;attention:Array<{id:string;severity:string;component:string;title:string;count:number;firstSeen:string;lastSeen:string;href:string}>;activity:Array<{id:string;type:string;createdAt:string;userId?:string;proofId?:string;summary:string}>};
export type Detail = {title:string;subtitle:string;fields:Array<{label:string;value:Scalar}>;sections:Section[];actions:Action[]};
export type Trend = {metric:string;label:string;bucketLabel?:string;bucketMs?:number;points:Array<{date:string;endDate?:string;value:number;previous:number|null}>;status:string;note?:string};
export type AdminIdentity = {userId:string;role:string;environment?:string;allowed?:boolean};
