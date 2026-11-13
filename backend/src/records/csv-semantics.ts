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
    rules.forbiddenShipmentAliases.includes(key)
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
    const candidates = headers.filter(
      (h) =>
        eligibleHeader(field, h) &&
        rows.every((row) => compatible(field, (row[h] ?? "").trim())),
    );
    const aliases = headers.filter((h) =>
      (rules.aliases[field] as string[]).includes(headerKey(h)),
    );
    const selected = mapping
      ? mapping[field]
      : aliases.length === 1
        ? aliases[0]
        : undefined;
    const required =
      rules.required.includes(field) && (field !== "shippedAt" || requireTime);
    let state: MatchState,
      reason: string,
      origin: FieldDecision["origin"] = selected ? "source_column" : "absent";
    if (!selected && field === "locationId" && boundLocation) {
      state = "validated";
      reason = "APPROVED_LOCATION";
      origin = "approved_binding";
    } else if (!selected) {
      state = required ? "missing_required" : "missing_optional";
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
      !rows.every((row) => compatible(field, (row[selected] ?? "").trim()))
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
      !(rules.aliases[field] as string[]).includes(headerKey(selected)) &&
      !confirmedFields.includes(field)
    ) {
      state = "needs_confirmation";
      reason = "COLUMN_MEANING_REQUIRED";
    } else {
      state = "validated";
      reason = "SEMANTIC_AND_VALUE_CHECKS";
    }
    return {
      field,
      sourceColumnId: selected ?? null,
      state,
      reasonCodes: [reason],
      origin,
      candidates,
    };
  });
}
