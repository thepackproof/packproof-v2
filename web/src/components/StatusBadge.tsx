export function statusTone(statusLabel: string): "neutral" | "info" | "success" | "warning" {
  const value = statusLabel.toLowerCase();
  if (
    value.includes("completed") ||
    value.includes("secured") ||
    value.includes("delivered") ||
    value.includes("sealed") ||
    value.includes("finalized") ||
    value.includes("awaiting shipment")
  ) {
    return "success";
  }
  if (
    value.includes("packing") ||
    value.includes("evidence") ||
    value.includes("transit") ||
    value.includes("shipping") ||
    value.includes("uploading") ||
    value.includes("securing") ||
    value.includes("invitation")
  ) {
    return "info";
  }
  if (value.includes("waiting") || value.includes("offline") || value.includes("attention") || value.includes("needed")) {
    return "warning";
  }
  return "neutral";
}

export function StatusBadge(props: { label: string; tone?: "neutral" | "info" | "success" | "warning" }) {
  const tone = props.tone ?? statusTone(props.label);
  return <span className={`status-badge status-badge-${tone}`}>{props.label}</span>;
}
