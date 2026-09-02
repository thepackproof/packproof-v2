const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function formatDate(value: string | Date | null | undefined): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) {
    return "";
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatTime(value: string | Date | null | undefined): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) {
    return "";
  }
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const date = formatDate(value);
  const time = formatTime(value);
  if (date && time) {
    return `${date} at ${time}`;
  }
  return date || time;
}

export function formatDateTimeCompact(value: string | Date | null | undefined): string {
  const date = formatDate(value);
  const time = formatTime(value);
  if (date && time) {
    return `${date} • ${time}`;
  }
  return date || time;
}

export function youRoleLabel(input: { role: string | null | undefined; isCurrentUser: boolean }): string {
  const role = roleLabel(input.role);
  if (input.isCurrentUser && role) {
    return `You • ${role}`;
  }
  return role;
}

export function greetingForHour(hour: number): string {
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 17) {
    return "Good afternoon";
  }
  return "Good evening";
}

export function greetingNow(now = new Date()): string {
  return greetingForHour(now.getHours());
}

export function displayName(input: {
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
  fallback?: string;
}): string {
  const name = input.displayName?.trim();
  if (name) {
    return name;
  }
  const username = input.username?.trim();
  if (username) {
    return username;
  }
  const email = input.email?.trim();
  if (email) {
    return email;
  }
  return input.fallback ?? "You";
}

export function firstName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function shortenId(id: string | null | undefined, visible = 4): string {
  if (!id) {
    return "";
  }
  const compact = id.replace(/[^A-Za-z0-9]/g, "");
  const tail = compact.slice(-visible).toUpperCase();
  return tail ? `••••${tail}` : "";
}

export function proofIdLabel(id: string | null | undefined): string {
  const short = shortenId(id);
  return short ? `Proof ${short}` : "Proof";
}

export function orderReferenceLabel(reference: string | null | undefined): string {
  const value = (reference ?? "").trim();
  if (!value) {
    return "";
  }
  const compact = value.replace(/^#+/, "");
  if (compact.length <= 18) {
    return `Order #${compact}`;
  }
  return `Order #${compact.slice(0, 12)}…`;
}

export function trackingEnding(tracking: string | null | undefined): string {
  const cleaned = String(tracking ?? "").replace(/\s+/g, "");
  if (!cleaned) {
    return "";
  }
  return `Tracking ending ${cleaned.slice(-4)}`;
}

export function shippingSummary(input: {
  carrier?: string | null;
  service?: string | null;
  trackingNumber?: string | null;
}): string {
  const name = [input.carrier, input.service].filter(Boolean).join(" ").trim();
  if (name) {
    return name;
  }
  return trackingEnding(input.trackingNumber);
}

export function moneyLabel(
  value: number | string | null | undefined,
  currency: string | null | undefined,
): string {
  if (value == null || value === "") {
    return "";
  }
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) {
    return String(value);
  }
  const code = (currency ?? "").trim().toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: code ? "currency" : "decimal",
      currency: code || undefined,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return code ? `${amount.toFixed(2)} ${code}` : amount.toFixed(2);
  }
}

export function quantityLabel(quantity: number | null | undefined): string {
  if (quantity == null) {
    return "";
  }
  return quantity === 1 ? "1 item" : `${quantity} items`;
}

export function roleLabel(role: string | null | undefined): string {
  switch ((role ?? "").toUpperCase()) {
    case "SELLER":
      return "Seller";
    case "BUYER":
      return "Buyer";
    default:
      return role ? role.replace(/_/g, " ").toLowerCase() : "";
  }
}

export function truncateMiddle(value: string, head = 10, tail = 4): string {
  if (value.length <= head + tail + 1) {
    return value;
  }
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function profileInitials(display: string | null | undefined, username?: string | null): string {
  const source = (display || username || "").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase() || "PP";
}
