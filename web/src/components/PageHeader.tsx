import type { ReactNode } from "react";
import { IconBack } from "./Icons";

export function PageHeader(props: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backLabel?: string;
  right?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-row">
        {props.onBack ? (
          <button type="button" className="icon-btn" onClick={props.onBack} aria-label={props.backLabel ?? "Back"}>
            <IconBack />
          </button>
        ) : (
          <span className="page-header-spacer" />
        )}
        <h1 className="page-header-title">{props.title}</h1>
        <div className="page-header-right">{props.right ?? <span className="page-header-spacer" />}</div>
      </div>
      {props.subtitle ? <p className="page-header-subtitle">{props.subtitle}</p> : null}
    </header>
  );
}
