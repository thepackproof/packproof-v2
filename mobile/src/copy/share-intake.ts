export function sharedOrderText(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "packproof-v2:" || parsed.hostname !== "intake") return null;
    const text = parsed.searchParams.get("text");
    return text && text.trim() && text.length <= 20000 ? text : null;
  } catch {
    return null;
  }
}
