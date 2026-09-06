import { providerAuthFailed, providerRateLimited, providerResponseInvalid, providerTemporarilyUnavailable, trackingNotFound } from '../../domain/integration-errors.js';

export interface ShippoHttp {
  request(input: { method: 'GET' | 'POST'; path: string; apiKey: string; body?: Record<string, unknown> }): Promise<{status:number; json:unknown}>;
}

export interface ShippoTrackingClient {
  getTracking(input: {carrier:string; trackingNumber:string; apiKey:string; register?:boolean; metadata?:string}): Promise<Record<string, unknown>>;
}

export class FetchShippoHttp implements ShippoHttp {
  async request(input: Parameters<ShippoHttp['request']>[0]) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`https://api.goshippo.com${input.path}`, {
        method: input.method,
        headers: {Authorization:`ShippoToken ${input.apiKey}`, Accept:'application/json', 'Content-Type':'application/json', 'SHIPPO-API-VERSION':'2018-02-08'},
        body: input.body ? JSON.stringify(input.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      text = await response.text();
    } catch { throw providerTemporarilyUnavailable(); }
    // Map errors before parsing; gateways can return non-JSON error pages.
    assertStatus(response.status);
    if (text.length > 2_000_000) throw providerResponseInvalid();
    try { return {status:response.status,json:JSON.parse(text) as unknown}; }
    catch { throw providerResponseInvalid(); }
  }
}

export function createShippoTrackingClient(http: ShippoHttp = new FetchShippoHttp()): ShippoTrackingClient {
  return {
    async getTracking(input) {
      const response = await http.request(input.register ? {
        method:'POST', path:'/tracks/', apiKey:input.apiKey,
        body:{carrier:input.carrier,tracking_number:input.trackingNumber,metadata:input.metadata ?? '',include_package_details:true},
      } : {
        method:'GET', path:`/tracks/${encodeURIComponent(input.carrier)}/${encodeURIComponent(input.trackingNumber)}`, apiKey:input.apiKey,
      });
      assertStatus(response.status);
      const value = object(response.json);
      if (!value) throw providerResponseInvalid();
      return value;
    },
  };
}

function assertStatus(status:number):void {
  if (status===401 || status===403) throw providerAuthFailed();
  if (status===404) throw trackingNotFound();
  if (status===429) throw providerRateLimited();
  if (status>=500 || status===408) throw providerTemporarilyUnavailable();
  if (status<200 || status>=300) throw providerResponseInvalid();
}

export function object(value:unknown): Record<string,unknown> | null {
  return value !== null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
