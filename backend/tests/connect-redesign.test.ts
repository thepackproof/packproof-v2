import { describe, it, expect } from 'vitest';
import { parseShipmentCsv } from '../src/records/csv.js';
import { validateAgentConfig, type Installation } from '../src/records/agent-enrollments.js';

// Synthetic regression modeled on the screenshot, not the original customer CSV.
const csv = 'Shipment reference,Description,Quantity,Shipment date\nPP-TEST-20261113-001,TEST ONLY - PVC elbow 1 inch,12,2026-11-13T09:00:00-05:00\n';
const wrong = { shipmentReference:'Description', itemTitle:'Shipment reference', quantity:'Shipment date', trackingNumber:'Shipment date', carrier:'Quantity', shippedAt:'Shipment date', locationId:'Description' };
describe('Connect screenshot regression at the authoritative boundaries', () => {
  it('does not silently substitute an order identifier for a shipment identifier', () => {
    expect(parseShipmentCsv('Order ID,Description,Quantity\nORDER-1,Elbow,12\n', undefined, 'UTC').rows[0].normalized).toBeNull();
  });
  it('does not fabricate missing contents or quantity', () => {
    expect(parseShipmentCsv('Shipment reference\nSHIP-1\n', undefined, 'UTC').rows[0].normalized).toBeNull();
  });
  it('rejects the screenshot mapping rather than counting selections', () => {
    expect(parseShipmentCsv(csv, wrong, 'UTC').rows.every(row => !row.normalized)).toBe(true);
  });
  it('keeps the real reference, description, quantity and offset timestamp', () => {
    expect(parseShipmentCsv(csv, undefined, 'UTC').rows[0].normalized).toMatchObject({ shipmentReference:'PP-TEST-20261113-001', itemTitle:'TEST ONLY - PVC elbow 1 inch', quantity:12, shippedAt:'2026-11-13T09:00:00-05:00', trackingNumber:null, carrier:null });
  });
});
