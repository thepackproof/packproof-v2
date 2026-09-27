import { classifyProofPresentation } from '../../../backend/src/domain/proof-presentation';
import { normalizeShippingBarcode } from '../../../backend/src/capture/shipping-barcode';
import type { ProofCollectionItem } from '../../../web/src/api/types';

export const presentation = (proof: ProofCollectionItem) => proof.presentation ?? classifyProofPresentation(proof);
export function humanize(value: string | null | undefined): string {
  return value ? value.replace(/[_-]/g, ' ').toLowerCase().replace(/^\w/, character => character.toUpperCase()) : 'Not available';
}
export function dateTime(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}).format(date);
}
export function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const level = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${(value / 1024 ** level).toFixed(level > 0 ? 1 : 0)} ${units[level]}`;
}
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 600);
}
export const normalizedCode = (value: string) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
export function trackingMatch(observed: string, expected: string): boolean {
  const actual = normalizeShippingBarcode(observed);
  const target = normalizeShippingBarcode(expected);
  return actual !== null && target !== null && actual === target;
}
export function appearsTracking(value: string): boolean {
  const normalized = normalizedCode(value);
  return /^1Z[A-Z0-9]{16}$/.test(normalized) || /^\d{20,34}$/.test(normalized) || /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalized);
}
