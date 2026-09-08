export type ProofsLibraryView = "in_progress" | "completed";

export type ProofsSort = "newest" | "oldest" | "price_high" | "price_low";

export type ProofsRoleFilter = "all" | "seller" | "buyer";

export type AuthPane = "signIn" | "createAccount" | "verify" | "forgot" | "reset";

export type AppRouteName =
  | "boot"
  | "auth"
  | "home"
  | "orders"
  | "create"
  | "account"
  | "sharing"
  | "signature"
  | "proof"
  | "capture"
  | "scan"
  | "intake"
  | "receipt"
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

export type WorkspaceOrigin = "home" | "orders" | "station";
export type AccountSection = "profile" | "channels" | "recordings" | "appearance" | "help" | "privacy";
export interface OrdersViewState { offsetY: number; query: string; }
export interface AppRoute {
  name: AppRouteName;
  accountSection?: AccountSection;
}

export interface ProofsLibraryState {
  view: ProofsLibraryView;
  query: string;
  sort: ProofsSort;
  role: ProofsRoleFilter;
  carrier: string | null;
}

export const DEFAULT_PROOFS_LIBRARY: ProofsLibraryState = {
  view: "in_progress",
  query: "",
  sort: "newest",
  role: "all",
  carrier: null,
};

/** @deprecated Use home. Kept so older session restore paths can be remapped. */
export function normalizeRouteName(name: string): AppRouteName {
  if (name === "tabs") {
    return "home";
  }
  return name as AppRouteName;
}

export function resolveBackRoute(routeName: AppRouteName, origin: WorkspaceOrigin = "home"): AppRouteName {
  switch (routeName) {
    case "sharing":
    case "signature":
    case "receipt":
    case "finalize":
    case "invite":
    case "editPurchase":
    case "editShipping":
    case "event":
    case "complete":
      return "proof";
    case "capture":
      return origin === "home" ? "proof" : origin;
    case "station":
      return "orders";
    case "proof":
    case "account":
    case "create":
    case "manual":
      return origin;
    case "scan":
    case "intake":
    case "review":
      return "create";
    default:
      return "home";
  }
}

export function showsTabBar(): boolean {
  return true;
}

export function isImmersiveRoute(route: AppRoute): boolean {
  return route.name === "station" || route.name === "scan" || route.name === "capture";
}

/** @deprecated Use isImmersiveRoute. */
export function isDarkRoute(route: AppRoute): boolean {
  return isImmersiveRoute(route);
}
