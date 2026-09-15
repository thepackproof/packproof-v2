/** Scanner framing is not part of a parcel's tracking number. Never interpret arbitrary GS1 fields as tracking. */
export function normalizeShippingBarcode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 128) return null;
  const framed = raw.replace(/^\]C[01]/, '').replace(/^\u001d/, '');
  const value = framed.replace(/[ \t\r\n-]/g, '').toUpperCase();
  // USPS IMpb: routing AI 420 + ZIP/ZIP+4, optional FNC1 separator, then the parcel identifier.
  const routed = /^420(?:\d{5}|\d{9})\u001d?(9[2345]\d{20})$/.exec(value);
  if (routed) return routed[1];
  if (/^[A-Z0-9]{10,26}$/.test(value) && /\d/.test(value)) return value;
  return null;
}

export function recognizeShippingBarcode(raw: unknown) {
  const value = normalizeShippingBarcode(raw);
  if (!value) return null;
  if (/^1Z[A-Z0-9]{16}$/.test(value)) return { trackingNumber: value, carrierHint: 'UPS', distinctive: true };
  if (/^9[2345]\d{20}$/.test(value)) return { trackingNumber: value, carrierHint: 'USPS', distinctive: true };
  return { trackingNumber: value, carrierHint: null, distinctive: false };
}
