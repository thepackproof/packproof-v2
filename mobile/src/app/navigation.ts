export type TabId = "home" | "proofs" | "create" | "activity" | "account";

export type ProofDetailTab = "overview" | "evidence" | "shipping" | "history";

export type ProofsFilter = "active" | "completed" | "invitations";

export type AuthPane = "signIn" | "createAccount" | "verify" | "forgot" | "reset";

export type AppRouteName =
  | "boot"
  | "auth"
  | "tabs"
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
  tab?: TabId;
}

export function showsTabBar(route: AppRoute): boolean {
  return route.name === "tabs";
}

export function isDarkRoute(route: AppRoute): boolean {
  return route.name === "station" || route.name === "scan" || route.name === "capture";
}
