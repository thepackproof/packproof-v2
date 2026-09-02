import { DomainError } from "./errors.js";

export const CAPTURE_RECIPES = [
  "CARD_STANDARD_V1",
  "CARD_DETAILED_V1",
  "PACKING_STANDARD_V1",
  "RECEIPT_STANDARD_V1",
] as const;

export type CaptureRecipeId = (typeof CAPTURE_RECIPES)[number];

export interface CaptureSlot {
  slot: string;
  required: boolean;
  media: "image" | "video";
  prompt: string;
}

export interface CaptureRecipe {
  id: CaptureRecipeId;
  title: string;
  evidenceType: "ASSET_CAPTURE" | "PACKING_CAPTURE" | "RECEIPT_CAPTURE";
  slots: CaptureSlot[];
}

const RECIPES: Record<CaptureRecipeId, CaptureRecipe> = {
  CARD_STANDARD_V1: {
    id: "CARD_STANDARD_V1",
    title: "Document item",
    evidenceType: "ASSET_CAPTURE",
    slots: [
      { slot: "FRONT", required: true, media: "image", prompt: "Capture the front" },
      { slot: "BACK", required: true, media: "image", prompt: "Capture the back" },
    ],
  },
  CARD_DETAILED_V1: {
    id: "CARD_DETAILED_V1",
    title: "Document item in detail",
    evidenceType: "ASSET_CAPTURE",
    slots: [
      { slot: "FRONT", required: true, media: "image", prompt: "Capture the front" },
      { slot: "BACK", required: true, media: "image", prompt: "Capture the back" },
      { slot: "OPTIONAL_CORNERS", required: false, media: "image", prompt: "Capture corners if useful" },
      { slot: "OPTIONAL_SURFACE_VIDEO", required: false, media: "video", prompt: "Record a surface video if useful" },
    ],
  },
  PACKING_STANDARD_V1: {
    id: "PACKING_STANDARD_V1",
    title: "Document packing",
    evidenceType: "PACKING_CAPTURE",
    slots: [
      { slot: "PACKING_VIDEO", required: true, media: "video", prompt: "Record packing" },
      { slot: "LABEL_CAPTURE", required: false, media: "image", prompt: "Capture the shipping label" },
    ],
  },
  RECEIPT_STANDARD_V1: {
    id: "RECEIPT_STANDARD_V1",
    title: "Document received items",
    evidenceType: "RECEIPT_CAPTURE",
    slots: [
      { slot: "PACKAGE", required: true, media: "image", prompt: "Capture the package as received" },
      { slot: "ITEM_FRONT", required: true, media: "image", prompt: "Capture the front as received" },
      { slot: "ITEM_BACK", required: true, media: "image", prompt: "Capture the back as received" },
    ],
  },
};

export function isCaptureRecipeId(value: unknown): value is CaptureRecipeId {
  return typeof value === "string" && (CAPTURE_RECIPES as readonly string[]).includes(value);
}

export function requireCaptureRecipe(value: unknown): CaptureRecipe {
  if (!isCaptureRecipeId(value)) {
    throw new DomainError("INVALID_CAPTURE_RECIPE", "capture recipe is not allowed", 400);
  }
  return RECIPES[value];
}

export function recipeForObservation(observationType: string): CaptureRecipe | null {
  switch (observationType) {
    case "ORIGIN_CAPTURE":
      return RECIPES.CARD_STANDARD_V1;
    case "PACKED":
    case "RETURN_PACKED":
      return RECIPES.PACKING_STANDARD_V1;
    case "RECEIVED":
    case "INTAKE_CAPTURE":
      return RECIPES.RECEIPT_STANDARD_V1;
    default:
      return null;
  }
}

export function assertRecipeEvidence(
  recipe: CaptureRecipe,
  slots: Array<{ slot: string; evidenceId: string }>,
): void {
  const provided = new Set(slots.map((row) => row.slot));
  for (const slot of recipe.slots) {
    if (slot.required && !provided.has(slot.slot)) {
      throw new DomainError(
        "CAPTURE_SLOT_REQUIRED",
        `Required capture is missing: ${slot.prompt}`,
        422,
      );
    }
  }
  const allowed = new Set(recipe.slots.map((row) => row.slot));
  for (const row of slots) {
    if (!allowed.has(row.slot)) {
      throw new DomainError("INVALID_CAPTURE_SLOT", "capture slot is not part of this recipe", 400);
    }
  }
}

export function listCaptureRecipes(): CaptureRecipe[] {
  return CAPTURE_RECIPES.map((id) => RECIPES[id]);
}
