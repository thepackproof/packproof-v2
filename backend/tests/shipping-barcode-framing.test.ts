import { describe, it, expect } from 'vitest';
import { recognizeShippingBarcode } from '../src/capture/shipping-barcode.js';
import { classifyIdentifier } from '../src/identifiers/core.js';

describe('USPS scanner framing reaches the scoped shipping resolver', () => {
  const tracking = '9400111899223847182989';
  it('accepts plain, routed, AIM-prefixed and FNC1-separated IMpb while preserving the tracking identity', () => {
    for (const raw of [tracking, `42043054${tracking}`, `420430541234${tracking}`, `]C142043054\u001d${tracking}`, `\u001d420430541234\u001d${tracking}`, `]C1${tracking}`]) {
      expect(recognizeShippingBarcode(raw)).toEqual({trackingNumber:tracking,carrierHint:'USPS',distinctive:true});
      expect(classifyIdentifier({rawText:raw,symbology:'CODE_128'}).kind).toBe('OPAQUE');
    }
  });
  it('does not turn product GS1 fields, unrelated controls or multiple tracking values into a parcel', () => {
    for (const raw of [`42043054\u001d${tracking}\u001d10BATCH`, `${tracking}\u001d${tracking}`, `\u0000${tracking}`, `]Q3${tracking}`]) {
      expect(recognizeShippingBarcode(raw)).toBeNull();
    }
    expect(classifyIdentifier({rawText:']C10109506000134352',symbology:'CODE_128'}).kind).not.toBe('OPAQUE');
    expect(classifyIdentifier({rawText:tracking,symbology:'EAN_13'}).kind).toBe('PRODUCT');
  });
});
