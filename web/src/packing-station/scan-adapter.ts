export type WebScanAdapterKind = "KEYBOARD" | "CAMERA";

export interface WebScanAdapter {
  kind: WebScanAdapterKind;
  supported: boolean;
}

export function detectWebScanAdapter(): WebScanAdapter {
  return { kind: "KEYBOARD", supported: true };
}
