import { statusTone, type StatusTone } from "@packproof/copy/status-tone";
import { Glyph } from "../site/Brand";
export { statusTone } from "@packproof/copy/status-tone";

export function StatusBadge(props: { label: string; tone?: StatusTone }) {
  const tone = props.tone ?? statusTone(props.label);
  return <span className={`status-badge status-badge-${tone}`}><Glyph name={tone === "success" ? "check" : tone === "error" || tone === "warning" ? "alert" : tone === "info" ? "info" : "clock"} size={16} />{props.label}</span>;
}
