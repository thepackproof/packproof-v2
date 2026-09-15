export type ProofListView = "all" | "attention" | "completed";
export type ProofListState = { view: ProofListView; query: string };
const key = (scope: string) => `packproof.view.${scope}.proof-list`;
export function readProofListState(url: URL): ProofListState {
  const filter = url.searchParams.get("filter");
  return { view: filter === "all" || filter === "completed" ? filter : "attention", query: url.searchParams.get("q") || "" };
}
export function rememberProofListState(scope: string, state: ProofListState) {
  try { sessionStorage.setItem(key(scope), JSON.stringify(state)); } catch { /* Navigation works without storage. */ }
}
/** Replace retired destinations without inserting a second browser-history entry. */
export function canonicalWorkspacePath(href: string, scope?: string): string {
  const url = new URL(href, "https://packproof.local");
  const path = url.pathname.replace(/\/$/, "") || "/";
  // Owned HTTPS app links are locators only. Drop all query/fragment input before
  // routing; public /p links deliberately remain a separate sharing surface.
  if (path === "/app/packing" || path === "/app/proofs") {
    url.pathname = "/proofs";
    url.search = "?filter=attention";
    url.hash = "";
  } else if (/^\/app\/proofs\/[A-Za-z0-9_-]{1,160}$/.test(path)) {
    url.pathname = path.slice(4);
    url.search = "";
    url.hash = "";
  } else if (path.startsWith("/app/")) {
    // A capture handoff remains on its read-only fallback until an explicit
    // action. Malformed owned links recover to the authorized queue.
    url.pathname = /^\/app\/capture\/[A-Za-z0-9_-]{1,160}$/.test(path) ? path : "/proofs";
    url.search = "";
    url.hash = "";
  }
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
      if (saved && ["all", "attention", "completed"].includes(saved.view)) url.searchParams.set("filter", saved.view);
      // Search belongs to its history entry. Only the filter is a remembered default.
    } catch { /* The first visit defaults to Needs attention. */ }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
