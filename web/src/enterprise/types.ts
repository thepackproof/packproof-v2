export interface PilotSite{id:string;name:string;mode:'SYNTHETIC'|'HISTORICAL';role:'ADMIN'|'IMPORTER'|'REVIEWER'|'READ_ONLY';organization_id:string;}
export interface PilotQuantity{quantity:string|null;uom:string|null;recordIds:string[];coverage:string;}
export interface PilotException{key:string;code:string;lineId:string|null;recordIds:string[];message:string;logic:string;}
export interface PilotAsset{id:string;document_key:string;sha256:string;content_type:string;byte_size:number;record_id:string;}
export interface PilotEvent{id:string;recordKey:string;revision:string;sourceName:string;sourceId:string;importId:string;stage:string;fulfillmentId:string|null;occurredAtLocal:string|null;sourceTimezone:string|null;occurredAtUtc:string|null;timeConfidence:string;ingestedAt:string;association:string;provenance:string;evidence:PilotAsset[];warnings:string[];}
export interface PilotDossier{id:string;externalId:string;synthetic:boolean;site:{id:string;name:string;mode:string;fulfillmentMode:string};sourceId:string;notice:string;fulfillments:string[];
 sources:{id:string;name:string;last_import_at:string|null;stale:boolean}[];
 reconciliation:{lines:{id:string;externalId:string;itemIds:string[];effectiveOrdered:PilotQuantity;stages:Record<string,PilotQuantity>}[];exceptions:PilotException[]};
 timeline:PilotEvent[];evidence:PilotAsset[];annotations:{id:string;reason:string;disposition:string;actor_user_id:string;created_at:string}[];}
export interface PilotSearch{items:{id:string;externalId:string;exceptionCount:number;fulfillments:string[];synthetic:boolean}[];nextCursor:string|null;}
export interface PilotDiagnostics{sources:{id:string;name:string}[];mappings:{id:string;source_id:string;version:string;dictionary:unknown}[];imports:{id:string;source_id:string;created_at:string;manifest_sha256:string}[];
 quarantine:{id:string;source_id:string;record_key:string;revision:string;errors:string[];normalized:{candidateOrderIds:string[]}|null}[];unassociatedEvidence:{id:string;document_key:string}[];}
export interface PilotPreview{previewDigest:string;counts:{received:number;existing:number;quarantined:number;files:number};warnings:string[];records:{index:number;recordKey:string;errors:string[]}[];}
export interface PilotMetrics{synthetic:boolean;groups:{complexity:string;condition:string;started:number;completed:number;durationSeconds:{n:number;median:number|null;p90:number|null}}[];pairedComparison:{n:number;differenceSeconds:{median:number|null}};adjudicatedLinks:number;incorrectDefinitiveLinks:number;correctLinkRate:number|null;missingRecordVisibility:number|null;limitations:string[];}
