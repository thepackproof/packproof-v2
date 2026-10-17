export type ProofsLibraryView = "all" | "attention" | "progress" | "completed";

export type ProofsSort = "newest" | "oldest" | "price_high" | "price_low";

export type ProofsRoleFilter = "all" | "seller" | "buyer";

export type AuthPane = "signIn" | "createAccount" | "verify" | "forgot" | "reset";

export type AppRouteName =
  | "boot"
  | "auth"
  | "sample"
  | "home"
  | "proofs"
  | "orders"
  | "activity"
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

export type WorkspaceOrigin = "home" | "proofs" | "orders" | "station" | "activity";
export type AccountSection = "developer" | "billing" | "notifications" | "profile" | "channels" | "recordings" | "appearance" | "help" | "privacy" | "advanced";
export type ActivityFilter = "all" | "attention" | "uploading" | "completed" | "notifications";
export interface OrdersViewState { offsetY: number; query: string; filter?: "ready" | "started" | "completed" | "all"; }
export interface AppRoute {
  name: AppRouteName;
  /** Return from saved item information to the same capture. */
  returnToCapture?: boolean;
  accountSection?: AccountSection;
  supportingSection?: "responses" | "retention" | "privacy";
  historyShareId?: string;
  signatureTool?: 'replay' | 'ask' | 'case' | 'compare' | 'history';
  activityFilter?: ActivityFilter;
  activitySessionId?: string;
  /** Explicit secondary entry for grading/import; default creation is manual. */
  creationMode?: "options";
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

/** New Android accounts start with the complete catalog; remembered filters win. */
export function initialProofsLibrary(taskFirst: boolean): ProofsLibraryState {
  return { ...DEFAULT_PROOFS_LIBRARY, view: taskFirst ? 'all' : DEFAULT_PROOFS_LIBRARY.view };
}

/** Composition only: no draft, operation or capture state is changed here. */
export function creationEntryRoute(name: AppRouteName, taskFirst: boolean, mode?: AppRoute['creationMode']): AppRouteName {
  return taskFirst && name === 'create' && mode !== 'options' ? 'manual' : name;
}

/** Preserve workspace destinations while remapping retired session routes. */
export function normalizeRouteName(name: string): AppRouteName {
  if (["tabs", "overview"].includes(name)) {
    return "home";
  }
  return name as AppRouteName;
}

export function resolveBackRoute(routeName: AppRouteName, origin: WorkspaceOrigin = "home"): AppRouteName {
  switch (routeName) {
    case "sample": return origin;
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
    case "activity":
      return "home";
    case "proof":
    case "account":
    case "create":
    case "manual":
    case "intake":
      return origin;
    case "scan":
      return origin === "station" ? "station" : "create";
    case "review":
      return "create";
    default:
      return "home";
  }
}

export function showsTabBar(route?: AppRoute, captureActive = false): boolean {
  return Boolean(route && !captureActive && ["home", "proofs", "station", "activity", "orders", "account"].includes(route.name));
}

export function isImmersiveRoute(route: AppRoute): boolean {
  return route.name === "station" || route.name === "scan" || route.name === "capture";
}

/** @deprecated Use isImmersiveRoute. */
export function isDarkRoute(route: AppRoute): boolean {
  return isImmersiveRoute(route);
}
