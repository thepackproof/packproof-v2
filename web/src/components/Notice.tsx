import type { ReactNode } from "react";
import { Glyph } from "../site/Brand";

export function Notice({ title, children, kind = "info", action, onDismiss }: {
  title: string;
  children?: ReactNode;
  kind?: "info" | "success" | "warning" | "error";
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  return <div className={`pp-notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
    <span className="notice-icon"><Glyph name={kind === "success" ? "check" : kind === "info" ? "info" : "alert"} size={19} /></span>
    <div><strong>{title}</strong>{children && <div className="notice-content">{children}</div>}</div>
    {action && <div className="notice-action">{action}</div>}
    {onDismiss && <button className="icon-button" aria-label={`Dismiss ${title}`} onClick={onDismiss}><Glyph name="close" size={16} /></button>}
  </div>;
}
