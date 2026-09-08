/** Participant record links only. Public token links keep their existing browser access policy. */
export function proofIdFromLink(value:string):string|null {
  try {
    const url = new URL(value);
    if (!['packproof:', 'https:'].includes(url.protocol)) return null;
    if (url.protocol === 'https:' && !['thepackproof.com','www.thepackproof.com','app.thepackproof.com'].includes(url.hostname)) return null;
    const path = url.protocol === 'packproof:' ? `/${url.hostname}${url.pathname}` : url.pathname;
    const match = path.match(/^\/(?:app\/)?proofs?\/([a-zA-Z0-9_-]+)\/?$/);
    return match?.[1] ?? null;
  } catch { return null; }
}
