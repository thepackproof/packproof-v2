export type ProofsLibraryView = "all" | "attention" | "completed";

export type ProofsSort = "newest" | "oldest" | "price_high" | "price_low";

export type ProofsRoleFilter = "all" | "seller" | "buyer";

export type AuthPane = "signIn" | "createAccount" | "verify" | "forgot" | "reset";

export type AppRouteName =
  | "boot"
  | "auth"
  | "home"
  | "proofs"
  | "orders"
  | "create"
  | "account"
  | "sharing"
  | "signature"
  | "supporting"
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

export type WorkspaceOrigin = "home" | "proofs" | "orders" | "station";
export type AccountSection = "developer" | "billing" | "notifications" | "profile" | "channels" | "recordings" | "appearance" | "help" | "privacy";
export interface OrdersViewState { offsetY: number; query: string; }
export interface AppRoute {
  name: AppRouteName;
  accountSection?: AccountSection;
  supportingSection?: "responses" | "retention" | "privacy";
  historyShareId?: string;
}

export interface ProofsLibraryState {
  view: ProofsLibraryView;
  query: string;
  sort: ProofsSort;
  role: ProofsRoleFilter;
  carrier: string | null;
}

export const DEFAULT_PROOFS_LIBRARY: ProofsLibraryState = {
  view: "attention",
  query: "",
  sort: "newest",
  role: "all",
  carrier: null,
};

/** Preserve workspace destinations while remapping retired session routes. */
export function normalizeRouteName(name: string): AppRouteName {
  if (["tabs", "overview", "activity"].includes(name)) {
    return "home";
  }
  return name as AppRouteName;
}

export function resolveBackRoute(routeName: AppRouteName, origin: WorkspaceOrigin = "home"): AppRouteName {
  switch (routeName) {
    case "dev": return "account";
    case "sharing":
    case "signature":
    case "supporting":
    case "receipt":
    case "finalize":
    case "invite":
    case "editPurchase":
    case "editShipping":
    case "event":
    case "complete":
      return "proof";
    case "capture":
      return "proof";
    case "station":
    case "orders":
    case "proofs":
      return "home";
    case "proof":
    case "account":
    case "create":
    case "manual":
    case "intake":
      return origin;
    case "scan":
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
