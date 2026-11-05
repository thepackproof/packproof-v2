export const RECORD_VIEWS = [
  ['all', 'All records'], ['missing', 'Missing required evidence'], ['handoffs', 'Recent handoffs'],
  ['processing', 'Processing problems'], ['delayed', 'Data delayed'], ['ready', 'Ready to export'], ['site', 'My site'],
] as const;
export type RecordsSection = 'records' | 'attention' | 'connections' | 'exports' | 'settings' | 'setup';
export function recordsRoute(href: string): { section: RecordsSection; id: string | null; params: URLSearchParams } {
  const url = new URL(href, 'https://packproof.local');
  const match = url.pathname.match(/^\/app\/records\/([A-Za-z0-9_-]{1,160})$/);
  const section: RecordsSection = url.pathname.startsWith('/app/needs-attention') ? 'attention' : url.pathname.startsWith('/app/connections') ? 'connections' : url.pathname.startsWith('/app/exports') ? 'exports' : url.pathname.startsWith('/app/settings') ? 'settings' : url.pathname.startsWith('/app/setup') ? 'setup' : 'records';
  return { section, id: match?.[1] ?? null, params: url.searchParams };
}
export function recordsPath(section: RecordsSection, params: URLSearchParams, updates: Record<string, string | null> = {}, id?: string): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
  const base = section === 'records' ? `/app/records${id ? `/${encodeURIComponent(id)}` : ''}` : `/app/${section === 'attention' ? 'needs-attention' : section}`;
  return `${base}${next.size ? `?${next}` : ''}`;
}
export function displayState(value: unknown): string { return typeof value === 'string' && value ? value.replace(/[_-]+/g, ' ').toLowerCase().replace(/^./, letter => letter.toUpperCase()) : 'Unknown'; }
export function stateTone(value: unknown): 'neutral' | 'success' | 'warning' | 'error' {
  const state = String(value || '').toLowerCase();
  if (['up_to_date', 'complete', 'completed', 'succeeded', 'satisfied', 'sealed', 'reviewed', 'resolved', 'committed', 'available'].includes(state)) return 'success';
  if (['failed', 'error', 'integrity_mismatch', 'rejected'].includes(state)) return 'error';
  if (['needs_attention', 'action_needed', 'delayed', 'missing', 'reauthorization_required', 'conflict'].includes(state)) return 'warning';
  return 'neutral';
}
export function sourceLabel(source: unknown): string { return typeof source === 'string' ? source : source && typeof source === 'object' && 'name' in source && typeof source.name === 'string' ? source.name : 'Source not specified'; }
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
}
export function safeDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value, window.location.origin); return ['https:', ...(url.origin === window.location.origin ? ['http:'] : [])].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
