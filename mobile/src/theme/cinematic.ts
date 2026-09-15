import { colorsForScheme, type ColorScheme } from "./tokens";

/** Cinematic effects share the same semantic palette as the Figma screen components. */
export function cinematicForScheme(scheme: ColorScheme) {
  const colors = colorsForScheme(scheme);
  return {
    blue: colors.accentText, blueSoft: colors.accentSoft,
    green: colors.successText, greenSoft: colors.successSoft,
    violet: colors.integrityText, violetSoft: colors.integritySoft,
    teal: colors.shipmentText, tealSoft: colors.shipmentSoft,
    amber: colors.warningText, amberSoft: colors.warningSoft,
    red: colors.error, redSoft: colors.errorSoft,
  };
}

export const cinematic = cinematicForScheme("light");
