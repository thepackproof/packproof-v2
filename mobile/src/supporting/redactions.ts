export type RedactionMask = { x: number; y: number; width: number; height: number };
export type MaskDraft = { x: string; y: string; width: string; height: string };
export type Dimensions = { width: number; height: number };
export type RedactionCopy = {
  derivativeId: string;
  evidenceId: string;
  sourceSha256: string;
  status: 'PENDING' | 'FAILED' | 'READY' | 'REVIEWED';
  sha256: string | null;
  contentType: string | null;
  byteSize: number | null;
  reviewedAt?: string | null;
  failureCode?: string | null;
};

export const MAX_MASKS = 20;
export const MAX_SOURCE_BYTES = 250_000_000;
const sha256 = /^[a-f0-9]{64}$/i;
const mime = (value: string) => value.split(';', 1)[0].trim().toLowerCase();
export function mediaKind(contentType?: string | null): 'image' | 'video' | null {
  const type = mime(typeof contentType === 'string' ? contentType : '');
  return type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : null;
}

export function defaultMask(): MaskDraft { return { x: '5', y: '65', width: '90', height: '30' }; }

/** Percent fields describe the whole original frame, never a letterboxed view. */
export function buildMasks(drafts: MaskDraft[]): RedactionMask[] {
  if (!drafts.length || drafts.length > MAX_MASKS) throw new Error('Add between 1 and 20 private regions.');
  return drafts.map((draft, index) => {
    const number = (key: keyof MaskDraft) => {
      const text = draft[key].trim().replace(',', '.');
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(`Mask ${index + 1}: enter a percentage from 0 to 100 for each field.`);
      const value = Number(text) / 100;
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Mask ${index + 1}: percentages must be between 0 and 100.`);
      return value;
    };
    const x = number('x'), y = number('y'), width = number('width'), height = number('height');
    if (x >= 1 || y >= 1 || width <= 0 || height <= 0 || x + width > 1 + 1e-12 || y + height > 1 + 1e-12) {
      throw new Error(`Mask ${index + 1}: use a positive width and height that fit inside the frame.`);
    }
    return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
  });
}

export function fitMediaFrame(availableWidth: number, dimensions: Dimensions | null, maxHeight = 480): Dimensions | null {
  if (!dimensions || ![availableWidth, dimensions.width, dimensions.height, maxHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(availableWidth / dimensions.width, maxHeight / dimensions.height);
  return { width: dimensions.width * scale, height: dimensions.height * scale };
}

export function maskFromDrag(start: { x: number; y: number }, end: { x: number; y: number }, frame: Dimensions): MaskDraft | null {
  if (!fitMediaFrame(frame.width, frame) || ![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x1 = clamp(start.x / frame.width), x2 = clamp(end.x / frame.width);
  const y1 = clamp(start.y / frame.height), y2 = clamp(end.y / frame.height);
  if (Math.abs(x2 - x1) < 0.005 || Math.abs(y2 - y1) < 0.005) return null;
  // Round endpoints on the same integer grid before subtracting, so a drag
  // reaching the edge cannot round its origin + width outside the frame.
  const coordinate = (value: number) => Math.round(value * 100_000_000);
  const left = coordinate(Math.min(x1, x2)), right = coordinate(Math.max(x1, x2));
  const top = coordinate(Math.min(y1, y2)), bottom = coordinate(Math.max(y1, y2));
  const percent = (value: number) => String(value / 1_000_000);
  return { x: percent(left), y: percent(top), width: percent(right - left), height: percent(bottom - top) };
}

export function redactionStatus(copy: Pick<RedactionCopy, 'status'>): string {
  if (copy.status === 'PENDING') return 'Copy queued or rendering. Refresh to check its progress.';
  if (copy.status === 'FAILED') return 'Rendering failed. Review the source and masks, then request a new render.';
  if (copy.status === 'REVIEWED') return 'Reviewed private copy saved.';
  return 'Rendered copy ready for review.';
}

/** Only the exact server-rendered representation that was opened can be approved. */
export function approvalBody(opened: RedactionCopy, current: RedactionCopy | undefined, loadedHash: string | null, confirmed: boolean): { sha256: string } {
  if (!confirmed || !['READY', 'REVIEWED'].includes(opened.status) || !opened.sha256 || !sha256.test(opened.sha256) || loadedHash !== opened.sha256) {
    throw new Error('Open the rendered copy and confirm you have checked it before saving.');
  }
  if (!current || !['READY', 'REVIEWED'].includes(current.status) || current.derivativeId !== opened.derivativeId ||
      current.evidenceId !== opened.evidenceId || current.sourceSha256 !== opened.sourceSha256 || current.sha256 !== opened.sha256) {
    throw new Error('This copy changed or is no longer available. Open the latest rendered copy and review it again.');
  }
  return { sha256: opened.sha256 };
}

export function readCopies(value: unknown, evidenceIds: ReadonlySet<string>): RedactionCopy[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { derivatives?: unknown }).derivatives)) throw new Error('The private-copy list could not be read. Refresh and try again.');
  return (value as { derivatives: unknown[] }).derivatives.map(item => {
    if (!item || typeof item !== 'object') throw new Error('The server returned an invalid private copy.');
    const copy = item as RedactionCopy;
    if (typeof copy.derivativeId !== 'string' || !copy.derivativeId || typeof copy.evidenceId !== 'string' || !evidenceIds.has(copy.evidenceId) ||
        !['PENDING', 'FAILED', 'READY', 'REVIEWED'].includes(copy.status) || typeof copy.sourceSha256 !== 'string' || !sha256.test(copy.sourceSha256) ||
        (['READY', 'REVIEWED'].includes(copy.status) && (!copy.sha256 || !sha256.test(copy.sha256) || !mediaKind(copy.contentType)))) {
      throw new Error('The server returned a private copy that does not match this Proof. Refresh before continuing.');
    }
    return copy;
  });
}
