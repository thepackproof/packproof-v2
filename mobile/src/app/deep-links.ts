/** Participant record links only. Public token links keep their existing browser access policy. */
export function proofIdFromLink(value:string):string|null {
  try {
    const url = new URL(value);
    if (!['packproof:', 'packproof-v2:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (url.protocol === 'https:' && !['thepackproof.com','www.thepackproof.com','app.thepackproof.com'].includes(url.hostname)) return null;
    const path = url.protocol !== 'https:' ? `/${url.hostname}${url.pathname}` : url.pathname;
    const match = path.match(/^\/(?:app\/)?proofs?\/([a-zA-Z0-9_-]+)\/?$/);
    return match?.[1] ?? null;
  } catch { return null; }
}

export function historyShareFromLink(value: string): { proofId: string; shareId: string } | null {
  const proofId = proofIdFromLink(value);
  if (!proofId) return null;
  try {
    const url = new URL(value), ids = url.searchParams.getAll('historyShare');
    return ids.length === 1 && /^[A-Za-z0-9_-]{1,200}$/.test(ids[0]) ? { proofId, shareId: ids[0] } : null;
  } catch { return null; }
}

/** A commerce callback is only a refresh hint; server records decide connection status. */
export function connectionReturnFromLink(value: string): { provider: string; failed: boolean; code: string | null } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'packproof-v2:' || url.hostname !== 'connections' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/([a-z][a-z0-9_-]{0,39})\/?$/);
    if (!match) return null;
    return { provider: match[1], failed: url.searchParams.get(match[1]) === 'error', code: url.searchParams.get('code') };
  } catch { return null; }
}
