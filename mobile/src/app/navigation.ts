export type ProofsLibraryView = "in_progress" | "completed";

export type ProofsSort = "newest" | "oldest" | "price_high" | "price_low";

export type ProofsRoleFilter = "all" | "seller" | "buyer";

export type AuthPane = "signIn" | "createAccount" | "verify" | "forgot" | "reset";

export type AppRouteName =
  | "boot"
  | "auth"
  | "home"
  | "create"
  | "account"
  | "proof"
  | "capture"
  | "scan"
  | "manual"
  | "review"
  | "finalize"
  | "complete"
  | "invite"
  | "invitation"
  | "station"
  | "dev"
  | "editPurchase"
  | "editShipping"
  | "event";

export interface AppRoute {
  name: AppRouteName;
}

export interface ProofsLibraryState {
  view: ProofsLibraryView;
  query: string;
  sort: ProofsSort;
  role: ProofsRoleFilter;
  carrier: string | null;
  scrollOffset: number;
}

export const DEFAULT_PROOFS_LIBRARY: ProofsLibraryState = {
  view: "in_progress",
  query: "",
  sort: "newest",
  role: "all",
  carrier: null,
  scrollOffset: 0,
};

/** @deprecated Use home. Kept so older session restore paths can be remapped. */
export function normalizeRouteName(name: string): AppRouteName {
  if (name === "tabs") {
    return "home";
  }
  return name as AppRouteName;
}

export function resolveBackRoute(routeName: AppRouteName): AppRouteName {
  switch (routeName) {
    case "capture":
    case "finalize":
    case "invite":
    case "editPurchase":
    case "editShipping":
    case "event":
    case "complete":
      return "proof";
    case "scan":
    case "manual":
    case "review":
      return "create";
    default:
      return "home";
  }
}

export function showsTabBar(): boolean {
  return false;
}

export function isImmersiveRoute(route: AppRoute): boolean {
  return route.name === "station" || route.name === "scan" || route.name === "capture";
}

/** @deprecated Use isImmersiveRoute. */
export function isDarkRoute(route: AppRoute): boolean {
  return isImmersiveRoute(route);
}
