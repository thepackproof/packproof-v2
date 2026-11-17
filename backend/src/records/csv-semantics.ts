import rules from "./connect-csv-rules.json" with { type: "json" };
export { rules as CSV_RULES };
export type MatchState =
  | "validated"
  | "needs_confirmation"
  | "missing_optional"
  | "missing_required"
  | "incompatible";
export type SemanticField = keyof typeof rules.aliases;
export interface FieldDecision {
  field: SemanticField;
  sourceColumnId: string | null;
  state: MatchState;
  reasonCodes: string[];
  origin: "source_column" | "approved_binding" | "absent";
  candidates: string[];
  validRowCount: number;
  invalidRowCount: number;
}
export const headerKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
export const explicitInstant = (value: string): number | null => {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return null;
  const instant = Date.parse(value),
    day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(instant) &&
    Number.isFinite(day) &&
    value.slice(0, 4) !== "0000" &&
    instant >= -62135596800000 && instant <= 253402300799999 &&
    new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) &&
    Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60 &&
    (value.endsWith("Z") ||
      (Number(value.slice(-6, -3).replace(/[+-]/, "")) <= 14 &&
        Number(value.slice(-2)) < 60 &&
        (Number(value.slice(-6, -3).replace(/[+-]/, "")) !== 14 ||
          Number(value.slice(-2)) === 0)))
    ? instant
    : null;
};
export function eligibleHeader(field: SemanticField, header: string) {
  const key = headerKey(header);
  if (
    field === "shipmentReference" &&
    (rules.forbiddenShipmentAliases.includes(key) ||
      rules.interpretation.orderIdentifiers.includes(key) || rules.interpretation.lineIdentifiers.includes(key))
  )
    return false;
  const roles = Object.entries(rules.aliases)
    .filter(([, names]) => (names as string[]).includes(key))
    .map(([role]) => role);
  return roles.length === 0 || roles.includes(field);
}
export function fieldValueValid(field: SemanticField, value: string): boolean {
  if (field === "quantity")
    return (
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= rules.quantityMin &&
      Number(value) <= rules.quantityMax
    );
  if (field === "shippedAt") return explicitInstant(value) !== null;
  if (!value) return !rules.required.includes(field);
  if (
    value.length >
      (field === "carrier" || field === "trackingNumber"
        ? rules.shippingTextMax
        : rules.textMax) ||
    /\0/.test(value)
  )
    return false;
  if (field === "carrier" && /^\d+$/.test(value)) return false;
  return true;
}
export function analyzeColumns(
  headers: string[],
  rows: Record<string, string>[],
  mapping?: Record<string, string>,
  confirmedFields: string[] = [],
  boundLocation: string | null = null,
  requireTime = true,
  interpret = false,
): FieldDecision[] {
  const compatible = (field: SemanticField, value: string) =>
    field === "shippedAt" &&
    !requireTime &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
      ? true
      : fieldValueValid(field, value);
  const collision = new Set(headers.map(headerKey)).size !== headers.length;
  return (Object.keys(rules.aliases) as SemanticField[]).map((field) => {
    const matchingAlias = (h: string) => (rules.aliases[field] as string[]).includes(headerKey(h));
    const candidates = headers.filter(
      (h) =>
        eligibleHeader(field, h) &&
        rows.every((row) => compatible(field, (row[h] ?? "").trim())),
    );
    if (interpret) candidates.sort((a,b) => Number(matchingAlias(b)) - Number(matchingAlias(a)));
    const aliases = headers.filter(matchingAlias);
    const selected = mapping
      ? mapping[field]
      : aliases.length === 1
        ? aliases[0]
        : undefined;
    const required =
      rules.required.includes(field) && (field !== "shippedAt" || requireTime);
    const invalidRowCount = selected && headers.includes(selected)
      ? rows.filter(row => !compatible(field, (row[selected] ?? "").trim())).length : 0;
    const reviewAliases: Partial<Record<SemanticField, string[]>> = rules.interpretation.requiresConfirmation;
    let state: MatchState,
      reason: string,
      origin: FieldDecision["origin"] = selected ? "source_column" : "absent";
    if (!selected && field === "locationId" && boundLocation) {
      state = "validated";
      reason = "APPROVED_LOCATION";
      origin = "approved_binding";
    } else if (!selected) {
      state = required ? "missing_required" : interpret && aliases.length > 1 && !mapping ? "needs_confirmation" : "missing_optional";
      reason =
        aliases.length > 1
          ? "MULTIPLE_CANDIDATES"
          : required
            ? "REQUIRED_COLUMN_MISSING"
            : "OPTIONAL_NOT_PROVIDED";
    } else if (
      collision ||
      !headers.includes(selected) ||
      !eligibleHeader(field, selected) ||
      Object.entries(mapping ?? {}).some(
        ([other, h]) => other !== field && h === selected,
      )
    ) {
      state = "incompatible";
      reason = collision ? "HEADER_COLLISION" : "COLUMN_ROLE_CONFLICT";
    } else if (
      invalidRowCount > 0
    ) {
      state = "incompatible";
      reason = "VALUE_TYPE_OR_RANGE";
    } else if (
      field === "locationId" &&
      rows.some((row) => (row[selected] ?? "").trim() !== (boundLocation ?? ""))
    ) {
      state = "incompatible";
      reason = "LOCATION_BINDING_CONFLICT";
    } else if (
      (!(rules.aliases[field] as string[]).includes(headerKey(selected)) ||
       (interpret && reviewAliases[field]?.includes(headerKey(selected)))) &&
      !confirmedFields.includes(field)
    ) {
      state = "needs_confirmation";
      reason = "COLUMN_MEANING_REQUIRED";
    } else {
      state = "validated";
      reason = interpret && confirmedFields.includes(field) ? "CONFIRMED_COLUMN_MEANING" : "SEMANTIC_AND_VALUE_CHECKS";
    }
    return {
      field,
      sourceColumnId: selected ?? null,
      state,
      reasonCodes: [reason],
      origin,
      candidates,
      validRowCount: selected && headers.includes(selected) ? rows.length - invalidRowCount : 0,
      invalidRowCount,
    };
  });
}

/** Summarizes local or hosted validation. This decision grants no access. */
export function shipmentInterpretation(headers: string[], rows: Record<string, string>[], decisions: FieldDecision[]) {
  const policy = rules.interpretation;
  const keys = headers.map(headerKey);
  const identity = decisions.find(d => d.field === "shipmentReference")!;
  const rejected = decisions.filter(d => d.state !== "validated" && d.state !== "missing_optional");
  const codes = [...new Set(rejected.flatMap(d => d.reasonCodes))];
  let grain: "shipment" | "order" | "shipment_line" | "unknown" = "unknown";
  let blocked = rejected.some(d => d.state === "incompatible");
  if (keys.some(key => policy.lineIdentifiers.includes(key))) {
    grain = keys.some(key => key.startsWith("shipmentline")) ? "shipment_line" : "unknown";
    codes.push("LINE_GRAIN_REQUIRES_PROFILE");
    blocked = true;
  } else if (identity.state === "validated" && identity.sourceColumnId) {
    const values = rows.map(row => row[identity.sourceColumnId!].trim());
    if (new Set(values).size === rows.length) grain = "shipment";
    else { codes.push("REPEATED_SHIPMENT_REFERENCE"); blocked = true; }
  } else if (keys.some(key => policy.orderIdentifiers.includes(key)) && identity.candidates.length === 0) {
    grain = "order";
    codes.push("ORDER_SOURCE_REQUIRES_PROFILE");
    blocked = true;
  }
  const outcome = blocked ? "blocked" : rejected.length ? "needs_review" : "automatic";
  return { version: policy.version, outcome, grain, reasonCodes: codes.length ? codes : ["SHIPMENT_ROWS_VALIDATED"] };
}
