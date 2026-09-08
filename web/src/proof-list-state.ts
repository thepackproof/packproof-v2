export type ProofListView = "all" | "attention" | "completed";
export type ProofListState = { view: ProofListView; query: string };
const key = (scope: string) => `packproof.view.${scope}.proof-list`;
export function readProofListState(url: URL): ProofListState {
  const filter = url.searchParams.get("filter");
  return { view: filter === "attention" || filter === "completed" ? filter : "all", query: url.searchParams.get("q") || "" };
}
export function rememberProofListState(scope: string, state: ProofListState) {
  try { sessionStorage.setItem(key(scope), JSON.stringify(state)); } catch { /* Navigation works without storage. */ }
}
/** Replace retired destinations without inserting a second browser-history entry. */
export function canonicalWorkspacePath(href: string, scope?: string): string {
  const url = new URL(href, "https://packproof.local");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const legacyRecord = path.match(/^\/(?:fulfillment|orders)\/([^/]+)$/);
  const completed = path.match(/^\/proofs\/([^/]+)\/complete$/);
  if (legacyRecord || completed) url.pathname = `/proofs/${(legacyRecord || completed)![1]}`;
  else if (path === "/station") {
    const id = url.searchParams.get("proof");
    url.pathname = id ? `/proofs/${encodeURIComponent(id)}` : "/proofs";
    url.searchParams.delete("proof");
    if (!id) url.searchParams.set("filter", "attention");
  } else if (["/app", "/home", "/overview", "/activity", "/fulfillment", "/orders"].includes(path)) {
    url.pathname = "/proofs";
    if (["/fulfillment", "/orders"].includes(path) && !url.searchParams.has("filter")) url.searchParams.set("filter", "attention");
  }
  if (url.pathname === "/proofs" && scope && !url.search && href !== "/proofs?filter=all") {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key(scope)) || "null") as ProofListState | null;
      if (saved?.view && saved.view !== "all") url.searchParams.set("filter", saved.view);
      // Search belongs to its history entry. Only the filter is a remembered default.
    } catch { /* The first visit defaults to All. */ }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
