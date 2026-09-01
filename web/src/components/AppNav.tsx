import type { WebSession } from "../auth/session";

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

const LINKS: Array<{ href: string; label: string; match: AppRouteName[] }> = [
  { href: "/", label: "Home", match: ["home"] },
  { href: "/proofs", label: "Proofs", match: ["proofs", "proof"] },
  { href: "/new", label: "Create", match: ["create"] },
  { href: "/activity", label: "Activity", match: ["activity"] },
  { href: "/fulfillment", label: "Fulfillment", match: ["fulfillment", "fulfillment-detail"] },
  { href: "/station", label: "Station", match: ["station"] },
  { href: "/stores", label: "Stores", match: ["stores"] },
  { href: "/account", label: "Account", match: ["account"] },
];

export function AppNav(props: {
  routeName: AppRouteName;
  session: WebSession;
  onGo: (path: string) => void;
  onSignOut: () => void;
}) {
  return (
    <header className="topbar">
      <a
        className="brand"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          props.onGo("/");
        }}
      >
        <img src="/packproof-logo.png" alt="" width={28} height={28} />
        PackProof
      </a>
      <nav className="topbar-nav" aria-label="Primary">
        {LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            aria-current={link.match.includes(props.routeName) ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              props.onGo(link.href);
            }}
          >
            {link.label}
          </a>
        ))}
      </nav>
      <div className="topbar-meta">
        <span>{props.session.displayName || props.session.username || props.session.subject}</span>
        <button className="btn btn-secondary" type="button" onClick={props.onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
