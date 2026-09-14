import { classifyIdentifier, normalizeSymbology } from '../../../backend/src/identifiers/core';
import type { IdentifierObservation, IdentifierPolicy, IdentifierResolution, IdentifierReview } from '../../../backend/src/identifiers/types';
import type { UnifiedBarcodeDetection } from '../../modules/packproof-unified-camera';
import type { ShippingScan } from './shipping-scan-queue';
import { recognizeShippingBarcode } from '../../../backend/src/capture/shipping-barcode';

/** Feedback describes a read; association and conflicts still come from the scoped server. */
export function shippingReadFeedback(review: IdentifierReview | null, event: UnifiedBarcodeDetection): { key: string; label: string; conflict: boolean } | null {
  const row = review?.observations.find(item => item.observation.rawText === event.rawValue);
  if (row && (row.route !== 'SHIPPING' || row.decision?.decision === 'NOT_THIS_SHIPMENT')) return null;
  const candidate = recognizeShippingBarcode(event.rawValue);
  if (!row && (review || !candidate?.distinctive || /EAN|UPC/i.test(event.format))) return null;
  const conflict = row?.reviewRequired === true;
  return { key: candidate?.trackingNumber ?? event.rawValue,
    label: conflict ? 'Shipping label needs review' : review ? 'Shipping barcode read' : 'Shipping barcode read · checking details', conflict };
}

export function identifierCaptureEnabled(policy: IdentifierPolicy | undefined | null): boolean {
  return policy?.version === 1 && policy.surface === 'ANDROID' && policy.captureEnabled === true;
}

/** Shared classification also prevents unrelated QR secrets entering capture metadata. */
export function mayRetainIdentifier(event: UnifiedBarcodeDetection): boolean {
  return classifyIdentifier({ rawText: event.rawValue, symbology: event.format, symbologyIdentifier: event.symbologyIdentifier }).kind !== 'UNSUPPORTED';
}

export function identifierObservation(event: UnifiedBarcodeDetection, sessionId: string): Omit<IdentifierObservation, 'schemaVersion' | 'clientEventId' | 'captureSessionId' | 'sequence' | 'firstSeenMs' | 'lastSeenMs' | 'sightings'> {
  return {
    rawText: event.rawValue, rawBytes: event.rawBytes ?? null, decoderEncoding: event.decoderEncoding ?? null,
    symbology: normalizeSymbology(event.format), symbologyIdentifier: event.symbologyIdentifier ?? null,
    source: event.source === 'ENCODED_VIDEO_FRAME' ? 'ENCODED_VIDEO_FRAME' : 'LIVE_CAMERA_ANALYSIS',
    mediaTimeMs: Math.max(0, Math.floor(event.detectedAtMs)),
    // Encoded reader returns a requested time, not a decoded frame PTS. Null uncertainty means unknown.
    timestampOrigin: event.source === 'ENCODED_VIDEO_FRAME' ? 'ENCODED_MEDIA' : 'MONOTONIC_APPROXIMATE',
    timestampUncertaintyMs: event.timestampUncertaintyMs ?? null,
    recordingRef: sessionId, adapterVersion: 'android-identifiers-1', decoderVersion: event.decoderVersion ?? 'UNREPORTED',
    capabilityProfile: 'ANDROID_MLKIT_17_2_0_V1_UNQUALIFIED',
    frameWidth: event.frameWidth ?? null, frameHeight: event.frameHeight ?? null,
    coordinateSpace: event.coordinateSpace ?? null,
    bounds: event.bounds ? { x: event.bounds.left, y: event.bounds.top, width: event.bounds.right - event.bounds.left, height: event.bounds.bottom - event.bounds.top } : null,
  };
}

export function identifierStatus(review: IdentifierReview | null, pending = false): string {
  if (review?.reviewRequired) return 'This code differs from the selected order. Check it at review.';
  if (review?.observations.some(row => row.route === 'PRODUCT' && row.state === 'MATCH')) return 'Item code matches this order';
  if (review?.observations.some(row => row.state === 'RESOLVED_PRODUCT')) return 'Item details found';
  if (review?.observations.some(row => row.route === 'SHIPPING')) return 'Shipping code read · check at review';
  if (pending) return 'Code read · saved on this device';
  return 'Code read; item details unavailable';
}

/** No local pattern can override the scoped server's product/shipping ambiguity. */
export function approvedIdentifierShipping(row: IdentifierResolution): ShippingScan | null {
  if (row.route !== 'SHIPPING' || row.decision?.decision === 'NOT_THIS_SHIPMENT') return null;
  const event = row.observation;
  return { rawValue: event.rawText, format: event.symbology, detectedAtMs: event.mediaTimeMs,
    idempotencyKey: `identifier:${row.clientEventId}`, source: event.source, decoderVersion: event.decoderVersion,
    coordinateSpace: event.coordinateSpace === 'DECODED_VIDEO_PIXELS' ? 'DECODED_VIDEO_PIXELS' : 'ROTATED_ANALYSIS_PIXELS',
    frameWidth: event.frameWidth ?? undefined, frameHeight: event.frameHeight ?? undefined,
    bounds: event.bounds ? { left: event.bounds.x, top: event.bounds.y, right: event.bounds.x + event.bounds.width, bottom: event.bounds.y + event.bounds.height } : null,
  };
}

export function identifierTime(row: IdentifierResolution): string {
  const seconds = Math.max(0, Math.floor(row.observation.mediaTimeMs / 1000));
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return row.observation.source === 'ENCODED_VIDEO_FRAME'
    ? `Read from the saved video near ${time}; exact frame time unavailable`
    : `Read during recording near ${time}; approximate video time`;
}
