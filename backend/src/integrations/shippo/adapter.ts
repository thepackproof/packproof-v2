import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, providerAuthFailed, providerResponseInvalid, webhookSignatureInvalid } from '../../domain/integration-errors.js';
import { sha256Hex } from '../../hash.js';
import type { IntegrationCredentials } from '../credentials.js';
import type { TrustedShipmentAdapter } from '../trusted-shipment-adapter.js';
import { createShippoTrackingClient, object, type ShippoTrackingClient } from './client.js';
import { normalizeShippoTracking, string, trackingIdentity } from './normalize.js';

export const SHIPPO_TRACKER_ADAPTER_KEY = 'shippo-tracker';
const testCodes = /^SHIPPO_(PRE_TRANSIT|TRANSIT|DELIVERED|RETURNED|FAILURE|UNKNOWN)$/;

export function parseShippoCredentials(credentials:IntegrationCredentials) {
  const apiKey = string(credentials.material.apiKey);
  const mode = apiKey.startsWith('shippo_test_') ? 'test' : apiKey.startsWith('shippo_live_') ? 'production' : null;
  if (!mode || (credentials.material.mode && credentials.material.mode!==mode)) throw providerAuthFailed();
  return {apiKey,mode,webhookSecret:string(credentials.material.webhookSecret),registerWebhooks:credentials.material.registerWebhooks==='true',hmacProvisioned:credentials.material.hmacProvisioned==='true'};
}

export function shippoCarrier(trackingNumber:string, hint?:string|null):string {
  if (testCodes.test(trackingNumber)) return 'shippo';
  const aliases:Record<string,string> = {ups:'ups',usps:'usps',fedex:'fedex','federal express':'fedex','dhl express':'dhl_express',dhl_express:'dhl_express'};
  const supplied = (hint ?? '').trim().toLowerCase();
  if (supplied && aliases[supplied]) return aliases[supplied];
  if (/^1Z[A-Z0-9]{16}$/.test(trackingNumber)) return 'ups';
  if (/^9[2345]\d{20}$/.test(trackingNumber)) return 'usps';
  // Numeric formats overlap between carriers. Do not guess FedEx from length alone.
  throw new IntegrationError('SHIPMENT_CARRIER_REQUIRED','Choose a supported shipping carrier before updating tracking',422,false);
}

export function createShippoShipmentAdapter(client:ShippoTrackingClient = createShippoTrackingClient()):TrustedShipmentAdapter {
  return {
    adapterKey:SHIPPO_TRACKER_ADAPTER_KEY,kind:'trusted',provider:'shippo',
    async getTrackingSnapshot(input) {
      const credentials = parseShippoCredentials(input.credentials), trackingNumber = trackingIdentity(input.trackingNumber);
      const isSimulation = testCodes.test(trackingNumber);
      if ((credentials.mode==='test')!==isSimulation) {
        throw new IntegrationError('SHIPPO_TEST_TRACKING_ONLY','Shippo test credentials support simulated tracking numbers; real packages require live credentials',422,false);
      }
      const carrier = shippoCarrier(trackingNumber,input.carrier);
      const cursor = `shippo:v1:${credentials.mode}:${carrier}:${trackingNumber}`;
      // Register externally purchased labels when enabled for this account/mode.
      // Ordinary notifications trigger authenticated polling; HMAC is optional.
      const register = credentials.registerWebhooks && input.providerCursor!==cursor;
      const tracker = await client.getTracking({carrier,trackingNumber,apiKey:credentials.apiKey,register,metadata:input.transactionId});
      assertMode(tracker,credentials.mode);
      if (trackingIdentity(string(tracker.tracking_number))!==trackingNumber || string(tracker.carrier).toLowerCase()!==carrier) throw providerResponseInvalid();
      return {...normalizeShippoTracking(tracker),providerCursor:register || input.providerCursor===cursor ? cursor : null};
    },
    async verifyWebhook(input) {
      const credentials = parseShippoCredentials(input.credentials);
      if (!credentials.hmacProvisioned) throw webhookSignatureInvalid();
      verifyShippoSignature(input.headers,input.rawBody,credentials.webhookSecret);
      let event:Record<string,unknown>|null;
      try {event=object(JSON.parse(input.rawBody.toString('utf8')));} catch {throw providerResponseInvalid();}
      if (!event) throw providerResponseInvalid();
      assertMode(event,credentials.mode);
      if (event.event!=='track_updated') return {providerEventId:`shippo:${sha256Hex(input.rawBody)}`,trackingNumber:null,observations:[]};
      const data = object(event.data);
      if (!data) throw providerResponseInvalid();
      // Shippo's envelope is authoritative when nested data omits test.
      if (data.test!==undefined) assertMode(data,credentials.mode);
      const tracker:Record<string,unknown> = {...data,test:event.test};
      const snapshot = normalizeShippoTracking(tracker);
      const number = trackingIdentity(string(tracker.tracking_number));
      if ((credentials.mode==='test')!==testCodes.test(number)) throw providerResponseInvalid();
      return {providerEventId:`shippo:${sha256Hex(input.rawBody)}`,trackingNumber:number,carrier:snapshot.carrier,observations:snapshot.observations};
    },
  };
}

function assertMode(value:Record<string,unknown>, mode:string):void {
  if (typeof value.test!=='boolean' || value.test!==(mode==='test')) throw providerResponseInvalid();
}

export function verifyShippoSignature(headers:Record<string,string|string[]|undefined>,body:Buffer,secret:string,now=Date.now()):void {
  const header = Object.entries(headers).find(([k])=>k.toLowerCase()==='shippo-auth-signature')?.[1];
  if (!secret || typeof header!=='string') throw webhookSignatureInvalid();
  const match = /^t=(\d{10}),v1=([a-fA-F0-9]{64})$/.exec(header.trim());
  if (!match || Math.abs(now/1000-Number(match[1]))>300) throw webhookSignatureInvalid();
  const expected = createHmac('sha256',secret).update(`${match[1]}.`).update(body).digest();
  if (!timingSafeEqual(expected,Buffer.from(match[2],'hex'))) throw webhookSignatureInvalid();
}
