import { sha256Hex } from '../../hash.js';
import { providerResponseInvalid } from '../../domain/integration-errors.js';
import type { TrustedTrackingObservation, TrustedTrackingSnapshot } from '../trusted-shipment-adapter.js';
import { object } from './client.js';

const statuses:Record<string,string> = {PRE_TRANSIT:'LABEL_CREATED',TRANSIT:'IN_TRANSIT',DELIVERED:'DELIVERED',RETURNED:'RETURN_TO_SENDER',FAILURE:'DELIVERY_EXCEPTION',UNKNOWN:'CARRIER_EVENT'};
const details:Record<string,string> = {out_for_delivery:'OUT_FOR_DELIVERY',package_arrived:'ARRIVED_AT_FACILITY',package_departed:'DEPARTED_FACILITY',package_accepted:'CARRIER_ACCEPTED',delayed:'DELIVERY_EXCEPTION',package_damaged:'DELIVERY_EXCEPTION',package_lost:'DELIVERY_EXCEPTION',delivery_attempted:'DELIVERY_EXCEPTION'};
export const string = (value:unknown):string => typeof value==='string' ? value.trim() : '';
export const trackingIdentity = (value:string):string => value.replace(/[ \t\r\n-]/g,'').toUpperCase();

export function normalizeShippoTracking(tracker:Record<string,unknown>):TrustedTrackingSnapshot {
  const trackingNumber = string(tracker.tracking_number), carrier = string(tracker.carrier).toLowerCase();
  if (!trackingNumber || !carrier || typeof tracker.test!=='boolean') throw providerResponseInvalid();
  const mode = tracker.test ? 'test' : 'production';
  const observations:TrustedTrackingObservation[] = [], seen = new Set<string>();
  const history = Array.isArray(tracker.tracking_history) ? tracker.tracking_history : [];
  for (const raw of [...history,tracker.tracking_status]) {
    const detail = object(raw);
    if (!detail) continue;
    const occurredAt = date(detail.status_date);
    if (!occurredAt) continue; // Never invent a carrier scan timestamp.
    const status = string(detail.status).toUpperCase(), substatus = object(detail.substatus);
    const location = object(detail.location);
    const locationText = location ? ['city','state','zip','country'].map(k=>string(location[k])).filter(Boolean).join(', ') || null : null;
    const message = string(detail.status_details), code = string(substatus?.code);
    const eventData = {shippoStatus:status,shippoSubstatus:code || null,message:message || null,mode,test:tracker.test,
      estimatedDeliveryDate:date(tracker.eta),actionRequired:substatus?.action_required===true};
    // Current status and history can have different object IDs for the same scan.
    // Content identity also survives provider ID changes across polling/webhooks.
    const sourceEventId = `shippo:${sha256Hex(JSON.stringify([mode,carrier,trackingIdentity(trackingNumber),occurredAt,status,code,locationText,eventData]))}`;
    if (seen.has(sourceEventId)) continue;
    seen.add(sourceEventId);
    observations.push({sourceEventId,carrierStatus:status,eventType:status==='TRANSIT' ? details[code] ?? statuses[status] : statuses[status] ?? 'CARRIER_EVENT',occurredAt,location:locationText,
      eventData});
  }
  // Optional package details are carrier-reported, not independent scale measurements.
  const reportedAt = date(object(tracker.tracking_status)?.status_date);
  if (reportedAt && Array.isArray(tracker.weight)) {
    const weight = tracker.weight.map(object).find(w=>w && ['oz','lb','g','kg'].includes(string(w.unit).toLowerCase()) && positive(w.value)!==null);
    if (weight) {
      const value = positive(weight.value)!, unit = string(weight.unit).toLowerCase();
      observations.push({sourceEventId:`shippo:weight:${sha256Hex(JSON.stringify([mode,carrier,trackingIdentity(trackingNumber),reportedAt,value,unit]))}`,eventType:'WEIGHT_RECORDED',occurredAt:reportedAt,
        eventData:{value,unit,reportedBy:'carrier',via:'shippo',mode,test:tracker.test,timestampBasis:'TRACKING_STATUS_DATE'}});
    }
  }
  return {provider:'shippo',carrier,observations,mode};
}

function positive(value:unknown):number|null {
  const n = typeof value==='number' || typeof value==='string' ? Number(value) : NaN;
  return Number.isFinite(n) && n>0 ? n : null;
}
function date(value:unknown):string|null {
  const s = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
