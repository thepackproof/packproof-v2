importScripts('parser.js', 'config.js');
const APP_ORIGIN = 'https://thepackproof.com';
const APP_ORIGINS = new Set([APP_ORIGIN, 'https://www.thepackproof.com']);
const HOST_PERMISSION = 'https://www.ebay.com/*';
const ADAPTER = globalThis.PACKPROOF_BROWSER_ADAPTER;
const MAX_PENDING = 30, RETAIN_MS = 24 * 60 * 60 * 1000;
// Content scripts cannot read extension storage, even after optional host permission.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let mutation = Promise.resolve();
const serialize = action => { const operation = mutation.then(action); mutation = operation.catch(() => {}); return operation; };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
async function state() {
  const data = await chrome.storage.local.get(['connection', 'pending', 'acknowledged', 'automatic']);
  return { connection: data.connection ?? null, pending: Array.isArray(data.pending) ? data.pending.filter(event => Date.now() - event.createdAt < RETAIN_MS).slice(0, MAX_PENDING) : [], acknowledged: Array.isArray(data.acknowledged) ? data.acknowledged.filter(event => Date.now() - event.createdAt < 10 * 60 * 1000).slice(-100) : [], automatic: data.automatic === true };
}
async function openApp() {
  await chrome.tabs.create({ url: `${APP_ORIGIN}/app?companion=${encodeURIComponent(chrome.runtime.id)}` });
}
async function wakeBackgroundBridge() {
  const expected = `${APP_ORIGIN}/app?companion=${encodeURIComponent(chrome.runtime.id)}&bridge=background`;
  const tabs = await chrome.tabs.query({ url: `${APP_ORIGIN}/app*` });
  const existing = tabs.find(tab => {
    try { const url = new URL(tab.url); return url.origin === APP_ORIGIN && url.pathname === '/app' && url.searchParams.get('companion') === chrome.runtime.id && url.searchParams.get('bridge') === 'background'; } catch { return false; }
  });
  // A dedicated companion tab can refresh its bounded polling window without stealing focus.
  // Ordinary PackProof workspace/recording tabs are never navigated or replaced.
  if (existing?.id) await chrome.tabs.update(existing.id, { url: `${expected}&delivery=${Date.now()}` });
  else await chrome.tabs.create({ url: expected, active: false });
}
async function capture(tabId, trigger) {
  if (!ADAPTER.validated) return { ok: false, reason: 'PAGE_ADAPTER_NOT_VALIDATED' };
  const current = await state();
  if (!current.connection) return { ok: false, reason: 'CONNECT_PACKPROOF' };
  if (current.pending.length >= MAX_PENDING) return { ok: false, reason: 'PENDING_QUEUE_FULL' };
  if (trigger === 'PRINT_LABEL' && (!current.automatic || !await chrome.permissions.contains({ origins: [HOST_PERMISSION] }))) return { ok: false, reason: 'AUTOMATIC_NOT_ENABLED' };
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito) return { ok: false, reason: 'INCOGNITO_NOT_SUPPORTED' };
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, func: globalThis.PackProofPageParser.extractPage, args: [ADAPTER], world: 'ISOLATED' });
  const parsed = results[0]?.result;
  if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? 'UNSUPPORTED_PAGE' };
  if (parsed.pageAccountReference !== current.connection.accountReference) return { ok: false, reason: 'STORE_ACCOUNT_MISMATCH' };
  const bytes = new TextEncoder().encode(JSON.stringify([current.connection.ownerId, current.connection.connectionId, parsed.observation]));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const prior = [...current.pending, ...current.acknowledged].find(event => event.sourceKey === hash);
  if (prior) return { ok: true, eventId: prior.eventId, status: 'ORDER_ALREADY_PREPARED' };
  const event = { ...parsed, eventId: crypto.randomUUID(), ownerId: current.connection.ownerId, connectionId: current.connection.connectionId, sourceKey: hash, adapterKey: ADAPTER.key, adapterVersion: ADAPTER.version, createdAt: Date.now(), trigger };
  delete event.ok;
  current.pending.push(event);
  await chrome.storage.local.set({ pending: current.pending, acknowledged: current.acknowledged });
  await chrome.action.setBadgeText({ text: String(current.pending.length) });
  await chrome.alarms.create('companion-pending', { delayInMinutes: 1, periodInMinutes: 1 });
  if (trigger === 'EXPLICIT') await openApp();
  else await wakeBackgroundBridge();
  return { ok: true, eventId: event.eventId, status: 'ORDER_READY_OPEN_PACKPROOF' };
}
async function setAutomatic(enabled) {
  if (enabled && !ADAPTER.validated) return { ok: false, reason: 'PAGE_ADAPTER_NOT_VALIDATED' };
  await chrome.scripting.unregisterContentScripts({ ids: ['packproof-print-observer'] }).catch(() => {});
  if (enabled) {
    if (!await chrome.permissions.contains({ origins: [HOST_PERMISSION] })) return { ok: false, reason: 'SITE_PERMISSION_REQUIRED' };
    await chrome.scripting.registerContentScripts([{ id: 'packproof-print-observer', matches: ['https://www.ebay.com/sh/ord/details*'], js: ['config.js', 'observer.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
  }
  await chrome.storage.local.set({ automatic: enabled });
  return { ok: true };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  if (!fromPopup && !(message?.type === 'PRINT_LABEL' && sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab?.id)) return false;
  serialize(async () => {
    if (message.type === 'CONNECT' && fromPopup) { await openApp(); return { ok: true }; }
    if (message.type === 'STATUS' && fromPopup) { const current = await state(); return { ok: true, validated: ADAPTER.validated, pending: current.pending.length, connected: !!current.connection, automatic: current.automatic }; }
    if (message.type === 'AUTOMATIC' && fromPopup) return setAutomatic(message.enabled === true);
    if (message.type === 'RECORD' && fromPopup) { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab?.id ? capture(tab.id, 'EXPLICIT') : { ok: false, reason: 'NO_ACTIVE_ORDER' }; }
    if (message.type === 'PRINT_LABEL' && sender.tab?.id) return capture(sender.tab.id, 'PRINT_LABEL');
    return { ok: false, reason: 'UNKNOWN_ACTION' };
  }).then(sendResponse, () => sendResponse({ ok: false, reason: 'TRY_AGAIN' }));
  return true;
});
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  let url; try { url = new URL(sender.url); } catch { return false; }
  if (!APP_ORIGINS.has(url.origin) || sender.frameId !== 0 || !sender.tab?.id || !validId(message?.ownerId)) return false;
  serialize(async () => {
    const current = await state();
    if (message.type === 'PACKPROOF_COMPANION_CONFIGURE') {
      if (!validId(message.connectionId) || typeof message.accountReference !== 'string' || !message.accountReference.trim() || message.accountReference.length > 200) return { ok: false, reason: 'INVALID_CONNECTION' };
      await chrome.storage.local.set({ connection: { ownerId: message.ownerId, connectionId: message.connectionId, accountReference: message.accountReference } });
      return { ok: true, adapterValidated: ADAPTER.validated };
    }
    if (message.type === 'PACKPROOF_COMPANION_DISCONNECT') {
      if (current.connection?.ownerId === message.ownerId) await chrome.storage.local.remove('connection');
      await setAutomatic(false);
      return { ok: true };
    }
    if (message.type === 'PACKPROOF_COMPANION_PULL') return { ok: true, events: current.pending.filter(event => event.ownerId === message.ownerId).slice(0, 5), status: ADAPTER.validated ? 'ORDER_READY_OPEN_PACKPROOF' : 'PAGE_ADAPTER_NOT_VALIDATED' };
    if (message.type === 'PACKPROOF_COMPANION_ACK' && validId(message.eventId)) {
      const accepted = current.pending.find(event => event.ownerId === message.ownerId && event.eventId === message.eventId);
      if (accepted) {
        // Retain only dedupe identifiers once the authenticated backend durably accepts.
        current.acknowledged.push({ eventId: accepted.eventId, sourceKey: accepted.sourceKey, createdAt: Date.now() });
        current.pending = current.pending.filter(event => event !== accepted);
        await chrome.storage.local.set({ pending: current.pending, acknowledged: current.acknowledged });
        await chrome.action.setBadgeText({ text: current.pending.length ? String(current.pending.length) : '' });
        if (!current.pending.length) await chrome.alarms.clear('companion-pending');
      }
      return { ok: true };
    }
    return { ok: false, reason: 'UNKNOWN_ACTION' };
  }).then(sendResponse, () => sendResponse({ ok: false, reason: 'TRY_AGAIN' }));
  return true;
});
chrome.permissions.onRemoved.addListener(() => serialize(async () => { if (!await chrome.permissions.contains({ origins: [HOST_PERMISSION] })) await setAutomatic(false); }));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'companion-pending') serialize(async () => { const current = await state(); await chrome.storage.local.set({ pending: current.pending, acknowledged: current.acknowledged }); await chrome.action.setBadgeText({ text: current.pending.length ? String(current.pending.length) : '' }); if (!current.pending.length) await chrome.alarms.clear('companion-pending'); }); });
