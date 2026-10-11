import type { WebSession } from '../auth/session';

const storageKey = 'packproof:first-proof:reauth:v1';
export type ReauthenticationTask = { version: 1; userId: string; apiBaseUrl: string; path: string };

/** A locator grants no access. Drop bearer links, fragments and all unknown query fields. */
export function safeTaskPath(href: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  const url = new URL(href, 'https://packproof.local');
  if (url.origin !== 'https://packproof.local') return null;
  const path = url.pathname;
  if (!/^\/(?:app|new|proofs|pack|activity|uploads|fulfillment|station|account|stores)$/.test(path)
    && !/^\/(?:receipt|invitations)\/[A-Za-z0-9_-]{1,200}$/.test(path)
    && !/^\/proofs\/[A-Za-z0-9_-]{1,200}(?:\/(?:capture|finalize|invite)|\/events\/[A-Za-z0-9_-]{1,200})?$/.test(path)) return null;
  const reference = url.searchParams.get('reference');
  return path === '/new' && reference && reference.length <= 200
    ? `${path}?${new URLSearchParams({ reference })}` : path;
}

export function retainReauthenticationTask(session: Pick<WebSession, 'userId' | 'apiBaseUrl'>, href: string): ReauthenticationTask | null {
  const path = safeTaskPath(href);
  if (!path) { clearReauthenticationTask(); return null; }
  const task: ReauthenticationTask = { version: 1, userId: session.userId, apiBaseUrl: session.apiBaseUrl, path };
  try { sessionStorage.setItem(storageKey, JSON.stringify(task)); } catch { /* The mounted app retains this non-secret locator in memory. */ }
  return task;
}

export function readReauthenticationTask(): ReauthenticationTask | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved?.version !== 1 || typeof saved.userId !== 'string' || typeof saved.apiBaseUrl !== 'string' || typeof saved.path !== 'string') return null;
    const path = safeTaskPath(saved.path);
    return path ? { version: 1, userId: saved.userId, apiBaseUrl: saved.apiBaseUrl, path } : null;
  } catch { return null; }
}

export function clearReauthenticationTask() {
  try { sessionStorage.removeItem(storageKey); } catch { /* The active app clears its memory copy as well. */ }
}

export function reauthenticationDestination(task: ReauthenticationTask, session: Pick<WebSession, 'userId' | 'apiBaseUrl'>): string {
  return task.userId === session.userId && task.apiBaseUrl === session.apiBaseUrl ? task.path : '/app';
}
