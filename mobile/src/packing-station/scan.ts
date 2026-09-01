export const STATION_BARCODE_TYPES = [
  "qr",
  "pdf417",
  "aztec",
  "ean13",
  "ean8",
  "upc_a",
  "upc_e",
  "code39",
  "code93",
  "code128",
  "codabar",
  "itf14",
  "datamatrix",
] as const;

export type StationBarcodeType = (typeof STATION_BARCODE_TYPES)[number];

export function normalizeStationReference(raw: string | null | undefined): string {
  let value = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  value = value.replace(/^#+/, "").trim();
  if (/^\][A-Za-z][0-9]/.test(value)) {
    value = value.slice(3).trim();
  }
  return value;
}

export function formatTrackingHint(tracking: string | null | undefined): string | null {
  const cleaned = String(tracking ?? "").replace(/\s+/g, "");
  if (!cleaned) {
    return null;
  }
  const tail = cleaned.slice(-4);
  return `Tracking ending ${tail}`;
}
