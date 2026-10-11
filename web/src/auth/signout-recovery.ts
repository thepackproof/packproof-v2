type LocalWork = { finalized?: boolean; submitted?: boolean; discardRequested?: boolean };

/** Explicit sign-out only. Expired authentication must never wait on this prompt. */
export async function confirmLocalWorkSignOut(options: {
  read: () => Promise<LocalWork[]>;
  current: () => boolean;
  confirm: (message: string) => boolean;
}): Promise<boolean> {
  let pending: number | null = null;
  try {
    const rows = await options.read();
    pending = rows.filter(row => !row.finalized && !row.submitted && !row.discardRequested).length;
  } catch { /* A storage failure must not trap someone in an authenticated account. */ }
  if (!options.current()) return false;
  if (pending === 0) return true;
  const message = pending === null
    ? 'Local work could not be checked. Signing out pauses unfinished uploads. Saved recordings remain in this browser for this account; sign in here again to resume. Clearing site data may remove local recordings. Sign out?'
    : `${pending} unfinished recording${pending === 1 ? '' : 's'} remain in this browser. Signing out pauses uploads. Sign in to this same account in this browser to resume. Clearing site data may remove local recordings. Sign out?`;
  return options.confirm(message) && options.current();
}
