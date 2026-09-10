import type { ColorScheme } from "./tokens";

export const cinematic = {
  blue: "#1769D2",
  blueSoft: "#E6F0FF",
  green: "#14805E",
  greenSoft: "#E5F5ED",
  violet: "#7653D6",
  violetSoft: "#F0EDFD",
  teal: "#0097A7",
  tealSoft: "#E4F7F8",
  amber: "#B36B00",
  amberSoft: "#FFF1D6",
  red: "#B42318",
  redSoft: "#FEECEB",
} as const;

export function cinematicForScheme(scheme: ColorScheme) {
  if (scheme === "dark") {
    return {
      ...cinematic,
      blueSoft: "#243C5B",
      green: "#7AD4B5",
      greenSoft: "#193D33",
      violet: "#C2B2FF",
      violetSoft: "#352D53",
      teal: "#71DDE5",
      tealSoft: "#173E43",
      amber: "#F5CB80",
      amberSoft: "#45351C",
      red: "#FFB4AA",
      redSoft: "#4D292B",
    } as const;
  }
  return cinematic;
}
