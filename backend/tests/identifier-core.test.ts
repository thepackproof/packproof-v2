import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { classifyIdentifier, expandUpce, identifierUtf8Bytes, normalizeGtin, normalizeSymbology, sanitizeIdentifierPayload } from '../src/identifiers/core.js';
import { GS1_DICTIONARY_REVISION, GS1_DICTIONARY_SHA256 } from '../src/identifiers/gs1/dictionary.js';

const classify = (rawText: string, symbology = 'Code128', symbologyIdentifier?: string) => classifyIdentifier({rawText, symbology, symbologyIdentifier});

describe('one shared identifier parser', () => {
  it.each([
    ['042100005264','UPC_A','00042100005264'], ['0042100005264','EAN13','00042100005264'],
    ['04252614','UPCE','00042100005264'], ['96385074','EAN_8','00000096385074'],
    ['10042100005261','ITF','10042100005261'],
  ])('normalizes %s (%s) without changing product identity', (value, format, expected) => {
    expect(normalizeGtin(value, format)).toBe(expected);
    expect(classify(value, format).kind).toBe('PRODUCT');
    expect(classify(value, format).identifiers[0].validationResult).toBe('VALID');
  });
  it.each([
    ['01234505','012000003455'], ['01234514','012100003454'], ['01234523','012200003453'],
    ['01234531','012300000451'], ['01234543','012340000053'], ['01234558','012345000058'],
    ['01234596','012345000096'], ['11234555','112345000055'],
  ])('expands every UPC-E suffix branch for %s', (compressed, expanded) => expect(expandUpce(compressed)).toBe(expanded));
  it.each([['042100005265','UPC_A'], ['04252615','UPC_E'], ['4252614','UPC_E'], ['24252614','UPC_E'],
    ['042100005264','EAN_13'], [' 042100005264','UPC_A'], ['9.6385074e7','EAN_8']])('rejects invalid GTIN %s', (value, format) => {
    expect(normalizeGtin(value, format)).toBeNull();
    expect(classify(value, format).kind).toBe('PRODUCT');
    expect(classify(value, format).identifiers[0].normalizedValue).toBeNull();
  });
  it('preserves significant SKU syntax without calling it a SKU or tracking yet', () => {
    const c = classify('00-blue.Widget/a');
    expect(c).toMatchObject({kind:'OPAQUE', identifiers:[{type:'UNKNOWN',value:'00-blue.Widget/a',normalizedValue:null}]});
    expect(classify('1Z999AA10123456784').kind).toBe('OPAQUE');
    expect(classify('012345678905', 'UPC_A').kind).toBe('PRODUCT');
  });
  it.each([['upc_e','UPC_E'],['UPCA','UPC_A'],['ean13','EAN_13'],['org.gs1.EAN-13','ORGGS1EAN13'],
    ['QRCode','QR_CODE'],['DataMatrix','DATA_MATRIX'],['pdf417','PDF_417'],['GS1-128','GS1_128'],['interleaved2of5','ITF']])
    ('normalizes decoder symbology alias %s', (input, expected) => expect(normalizeSymbology(input)).toBe(expected));
  it('parses GS1 GTIN, lot and serial as independent source identifiers', () => {
    const c = classify(']C1010952606405502810LOT-1\u001d21Ser.001');
    expect(c.identifiers.map(i => [i.type, i.normalizedValue, i.validationResult])).toEqual([
      ['GTIN','09526064055028','VALID'], ['LOT','LOT-1','VALID'], ['SERIAL','Ser.001','VALID']]);
    expect(classify('010952606405502810LOT-1\u001d21Ser.001').identifiers).toEqual(c.identifiers);
    expect(classify('010952606405502821Ser.001','DataMatrix',']d2')).toEqual(classify(']d2010952606405502821Ser.001','DataMatrix'));
  });
  it('does not guess where an unseparated variable-length field ends', () => {
    const c = classify(']C1010952606405502810LOT121SERIAL');
    expect(c.identifiers.map(i => i.type)).toEqual(['GTIN','LOT']);
    expect(c.identifiers[1].value).toBe('LOT121SERIAL');
    expect(classify(']C1010952606405502810'+ 'a'.repeat(21)).identifiers[1].validationResult).toBe('INVALID');
  });
  it('retains SSCC and contained GTIN meanings and leaves count unsupported', () => {
    const c = classify('(00)000123456789012343(02)09526064055028(37)6');
    expect(c.kind).toBe('STRUCTURED');
    expect(c.identifiers.map(i => i.type)).toEqual(['SSCC','CONTAINED_GTIN','UNKNOWN']);
    expect(c.identifiers[0].validationResult).toBe('VALID');
    expect(c.identifiers[1].validationResult).toBe('VALID');
    expect(c.identifiers[2]).toMatchObject({namespace:'GS1:37',validationResult:'UNSUPPORTED',normalizedValue:null});
  });
  it('checks required associations, mutually exclusive and duplicate AIs', () => {
    expect(classify('(21)SERIAL').identifiers[0].validationResult).toBe('UNVERIFIED');
    expect(classify('(02)09526064055028').identifiers[0].validationResult).toBe('UNVERIFIED');
    expect(classify('(01)09526064055028(02)09526064055028').identifiers.every(i => i.validationResult === 'INVALID')).toBe(true);
    expect(classify('(01)09526064055028(01)09526064055028').reasonCodes).toContain('GS1_DUPLICATE_AI');
  });
  it('validates expiry dates while retaining YYMMDD and permitted day zero', () => {
    const prefix = '(01)09526064055028(17)';
    expect(classify(prefix+'260200').identifiers[1]).toMatchObject({type:'EXPIRY',normalizedValue:'260200',validationResult:'VALID'});
    expect(classify(prefix+'260229').identifiers[1].validationResult).toBe('INVALID');
    expect(classify(prefix+'261331').identifiers[1].validationResult).toBe('INVALID');
  });
  it('does not bless truncated or malformed structured content', () => {
    expect(classify(']C101123').reasonCodes).toContain('GS1_FIELD_LENGTH_INVALID');
    expect(classify(']C10109526064055028\u001d').identifiers[0].validationResult).toBe('INVALID');
    expect(classify(']C101095260640550288888').identifiers[0].validationResult).toBe('INVALID');
    expect(classify('(01)09526064055028(9999)unsupported').identifiers[1].validationResult).toBe('UNSUPPORTED');
  });
  it('reads uncompressed Digital Link offline with dictionary qualifier order', () => {
    const c = classify('https://id.example/01/09526064055028/10/LOT-1/21/Ser.001?17=261231','QRCode');
    expect(c.kind).toBe('STRUCTURED');
    expect(c.identifiers.map(i => i.type)).toEqual(['GTIN','LOT','SERIAL','EXPIRY']);
    expect(c.identifiers.every(i => i.validationResult === 'VALID')).toBe(true);
    expect(classify('https://id.example/01/09526064055028/21/s/10/l','QRCode').kind).toBe('UNSUPPORTED');
  });
  it.each(['WIFI:S:secret-network;P:secret-password;;', 'BEGIN:VCARD\nFN:Private Person\nEND:VCARD',
    'upi://pay?pa=secret', 'https://example.org/private-token', 'javascript:alert(1)',
    'https://id.example/01/09526064055028?secret=token', 'https://user:secret@id.example/01/09526064055028',
    'https://id.example/01/09526064055028#private', 'https://id.example/01/09526064055028/21/%ZZ', ' https://example.org/secret'])
    ('suppresses unrelated or unsafe QR before persistence: %s', rawText => {
      const safe = sanitizeIdentifierPayload({rawText,rawBytes:'c2VjcmV0',symbology:'QRCode'});
      expect(safe.rawText.startsWith('[UNSUPPORTED:')).toBe(true);
      expect(safe.rawBytes).toBeNull();
      expect(classify(safe.rawText,'QRCode').kind).toBe('UNSUPPORTED');
      expect(JSON.stringify(safe)).not.toContain('secret');
    });
  it('bounds UTF-8 bytes, not only JavaScript character count', () => {
    expect(identifierUtf8Bytes('aé😀')).toBe(7);
    const safe = sanitizeIdentifierPayload({rawText:'😀'.repeat(1025),rawBytes:null,symbology:'QRCode'});
    expect(safe.rawText).toBe('[UNSUPPORTED:PAYLOAD_TOO_LARGE]');
  });
  it('pins the exact upstream GS1 resource used by all surfaces', () => {
    const resource = readFileSync(new URL('../src/identifiers/gs1/gs1-syntax-dictionary.txt', import.meta.url));
    expect(createHash('sha256').update(resource).digest('hex')).toBe(GS1_DICTIONARY_SHA256);
    expect(GS1_DICTIONARY_REVISION).toBe('c63d8a12210dd0cfaceac4aae45ccf57b48eb15b');
  });
});
