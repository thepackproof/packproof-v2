import type { TrustKind } from "../api/types";

const LABELS: Record<TrustKind, string> = {
  FACT: "PackProof fact",
  ATTESTATION: "User attestation",
  EXTERNAL: "External data",
};

export function TrustBadge(props: { kind: TrustKind }) {
  const className =
    props.kind === "FACT"
      ? "badge badge-fact"
      : props.kind === "ATTESTATION"
        ? "badge badge-attestation"
        : "badge badge-external";
  return <span className={className}>{LABELS[props.kind]}</span>;
}
