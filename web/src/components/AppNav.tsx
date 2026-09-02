import type { WebSession } from "../auth/session";
import { AvatarButton } from "./AvatarButton";

export type AppRouteName =
  | "home"
  | "proofs"
  | "create"
  | "activity"
  | "account"
  | "proof"
  | "fulfillment"
  | "fulfillment-detail"
  | "station"
  | "stores";

export function AppNav(props: {
  session: WebSession;
  invitationCount: number;
  onGoHome: () => void;
  onOpenAccount: () => void;
}) {
  return (
    <header className="topbar topbar-library">
      <a
        className="brand"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          props.onGoHome();
        }}
      >
        <img src="/packproof-logo.png" alt="" width={32} height={32} />
        PackProof
      </a>
      <AvatarButton
        displayName={props.session.displayName}
        username={props.session.username}
        notify={props.invitationCount > 0}
        onPress={props.onOpenAccount}
      />
    </header>
  );
}
