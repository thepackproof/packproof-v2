import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform, Pressable, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { SectionHeader } from '../ui/AppHeader';
import { FormField } from '../ui/FormField';
import { ErrorBanner } from '../ui/EmptyState';
import { InfoCard } from '../ui/ProofCard';
import { DeveloperAccessScope, DeveloperActionLock, StaleDeveloperRequest, developerKeyPath, leastDeveloperScopes, readDeveloperKeys, readDeveloperTenant, readDeveloperWorkspaces, readIssuedToken, type DeveloperKey, type DeveloperTenant } from './access';

type Lease = ReturnType<DeveloperAccessScope['lease']>;
const documentationUrl = 'https://github.com/thepackproof/packproof-v2/blob/main/docs/PUBLIC_API.md';
export function DeveloperAccessPanel() {
  const app = usePackProof(), { colors } = useTheme(), userId = app.session!.userId;
  const identity = useMemo(() => ({}), [app.client, app.apiBaseUrl, userId]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const guard = useMemo(() => new DeveloperAccessScope(app.client, userId, () => identityRef.current === identity), [identity]);
  const [tenants, setTenants] = useState<DeveloperTenant[]>([]), [tenantId, setTenantId] = useState('');
  const [availableScopes, setAvailableScopes] = useState<string[]>([]), [selectedScopes, setSelectedScopes] = useState<string[]>(['proofs:read']);
  const [keys, setKeys] = useState<DeveloperKey[]>([]), [workspaceName, setWorkspaceName] = useState('');
  const [token, setToken] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const active = useRef(true), lock = useRef(new DeveloperActionLock());
  const refreshOnResume = useRef(false);
  const body = [typography.body, { color: colors.textPrimary }], secondary = [typography.secondary, { color: colors.textSecondary }];
  const tenant = tenants.find(row => row.id === tenantId);
  const isCurrent = () => active.current && identityRef.current === identity;
  async function refresh(lease: Lease) {
    const result = readDeveloperWorkspaces(await lease.request<unknown>('')); lease.assert();
    setTenants(result.tenants); setAvailableScopes(result.availableScopes);
    setSelectedScopes(previous => previous.length ? previous.filter(scope => result.availableScopes.includes(scope)) : leastDeveloperScopes(result.availableScopes));
    if (guard.reconcileTenants(result.tenants.map(row => row.id))) { setTenantId(''); setToken(null); setKeys([]); setSelectedScopes(leastDeveloperScopes(result.availableScopes)); }
    return result;
  }
  async function reloadKeys(lease: Lease) { const listed = readDeveloperKeys(await lease.request<unknown>(developerKeyPath(lease.tenantId))); lease.assert(); setKeys(listed); }
  async function reloadVisibleWorkspace(lease: Lease) {
    const result = await refresh(lease);
    if (lease.tenantId && result.tenants.some(row => row.id === lease.tenantId)) await reloadKeys(lease);
  }
  async function run(work: (lease: Lease) => Promise<void>, requireTenant = false) {
    if (!isCurrent() || !lock.current.enter(guard)) return; setBusy(true); setError(null);
    try {
      const lease = guard.lease(requireTenant); await app.ensureAuth(); lease.assert(); await work(lease);
    } catch (reason) {
      if (isCurrent() && !(reason instanceof StaleDeveloperRequest)) setError(reason instanceof Error ? reason.message : 'Developer access could not be updated. Please try again.');
    } finally {
      const released = lock.current.leave(guard);
      if (isCurrent() && released) {
        setBusy(false);
        if (refreshOnResume.current && AppState.currentState === 'active') { refreshOnResume.current = false; void run(reloadVisibleWorkspace); }
      }
    }
  }
  useEffect(() => {
    active.current = true; refreshOnResume.current = false;
    setToken(null); setTenants([]); setKeys([]); setTenantId(''); setAvailableScopes([]); setSelectedScopes(['proofs:read']); setWorkspaceName(''); setError(null); setBusy(false);
    guard.setForeground(AppState.currentState === 'active'); void run(reloadVisibleWorkspace);
    const subscription = AppState.addEventListener('change', state => {
      guard.setForeground(state === 'active');
      if (state !== 'active') setToken(null);
      else if (lock.current.busy(guard)) refreshOnResume.current = true;
      else void run(reloadVisibleWorkspace);
    });
    return () => { active.current = false; guard.dispose(); lock.current.leave(guard); subscription.remove(); };
  }, [guard]);
  function chooseTenant(id: string) {
    guard.selectTenant(id); setTenantId(id); setToken(null); setKeys([]); setError(null); setSelectedScopes(leastDeveloperScopes(availableScopes));
    if (id) void run(reloadKeys, true);
  }
  async function showIssuedKey(lease: Lease, path: string, payload: unknown) {
    const currentTenant = tenants.find(row => row.id === lease.tenantId);
    if (!currentTenant) throw new Error('Choose a workspace before creating an API key.');
    setToken(null);
    const response = await lease.request<unknown>(path, 'POST', payload); lease.assert();
    setToken(readIssuedToken(response, currentTenant.environment));
    await reloadKeys(lease);
  }
  function confirmKeyChange(key: DeveloperKey, rotate: boolean) {
    const requestedTenant = tenantId;
    Alert.alert(rotate ? 'Rotate this API key?' : 'Revoke this API key?', rotate
      ? `${key.prefix}… will stop working immediately. Save the new key and update the integration on your server.`
      : `${key.prefix}… will stop working immediately. Integrations using it will lose access.`, [
      { text: 'Keep key', style: 'cancel' },
      { text: rotate ? 'Rotate key' : 'Revoke key', style: 'destructive', onPress: () => void run(async lease => {
        if (lease.tenantId !== requestedTenant) throw new StaleDeveloperRequest();
        if (rotate) await showIssuedKey(lease, developerKeyPath(lease.tenantId, key.id, true), {});
        else { setToken(null); await lease.request(developerKeyPath(lease.tenantId, key.id), 'DELETE'); await reloadKeys(lease); }
      }, true) },
    ]);
  }
  return <View style={{ gap: 16 }}>
    <Text style={body}>Connect your order system to the same PackProof record.</Text>
    <ErrorBanner message={error} />
    <SectionHeader title="Workspaces" />
    <View accessibilityRole="radiogroup" accessibilityLabel="API workspace">
      {tenants.map(workspace => <Pressable key={workspace.id} accessibilityRole="radio" accessibilityLabel={`${workspace.name}, ${workspace.environment}`} accessibilityState={{ checked: tenantId === workspace.id, disabled: busy }} disabled={busy} onPress={() => chooseTenant(workspace.id)} style={{ paddingVertical: 12 }}>
        <Text style={body}>{tenantId === workspace.id ? '◉' : '○'} {workspace.name} · {workspace.environment}</Text>
      </Pressable>)}
    </View>
    {!tenants.length && !busy ? <Text style={secondary}>No workspaces are available yet.</Text> : null}
    <InfoCard>
      <FormField label="New sandbox name" value={workspaceName} onChangeText={value => setWorkspaceName(value.slice(0, 80))} editable={!busy} autoCapitalize="words" />
      <Button label="Create sandbox" variant="secondary" disabled={busy || !workspaceName.trim()} onPress={() => void run(async lease => {
        const created = readDeveloperTenant(await lease.request<unknown>('', 'POST', { name: workspaceName.trim(), environment: 'sandbox' }));
        if (created.environment !== 'sandbox') throw new Error('The server did not confirm a sandbox workspace. Refresh before continuing.');
        const result = await refresh(lease); lease.assert();
        if (!result.tenants.some(row => row.id === created.id)) throw new Error('The new workspace is not available in this account. Refresh to retry.');
        guard.selectTenant(created.id); setTenantId(created.id); setWorkspaceName(''); setToken(null); setKeys([]); setSelectedScopes(leastDeveloperScopes(result.availableScopes));
        await reloadKeys(guard.lease(true));
      })} />
      <Text style={secondary}>Sandbox orders stay separate from live integrations. Use test orders and test media.</Text>
    </InfoCard>
    {tenant ? <>
      <SectionHeader title={`API keys · ${tenant.name}`} />
      <Text style={secondary}>Choose only the permissions this integration needs. Keep API keys on your server.</Text>
      <View accessibilityLabel="API key permissions">
        {availableScopes.map(scope => <Pressable key={scope} accessibilityRole="checkbox" accessibilityLabel={scope} accessibilityState={{ checked: selectedScopes.includes(scope), disabled: busy }} disabled={busy} onPress={() => setSelectedScopes(previous => previous.includes(scope) ? previous.filter(value => value !== scope) : [...previous, scope])} style={{ paddingVertical: 10 }}><Text style={body}>{selectedScopes.includes(scope) ? '☑' : '☐'} {scope}</Text></Pressable>)}
      </View>
      <Button label="Create API key" disabled={busy || !selectedScopes.length || !!token} onPress={() => void run(lease => showIssuedKey(lease, developerKeyPath(lease.tenantId), { name: 'Integration key', scopes: selectedScopes }), true)} />
      {token ? <InfoCard>
        <Text style={[typography.sectionTitle, { color: colors.textPrimary }]}>Save this key now</Text>
        <Text style={secondary}>This key is shown only once. PackProof does not save it on this device. It is hidden when you leave, change workspace, or put the app in the background.</Text>
        <Text selectable accessibilityLabel="New API key" style={[typography.body, { color: colors.textPrimary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{token}</Text>
        <Button label="Hide key" variant="secondary" onPress={() => setToken(null)} />
      </InfoCard> : null}
      {keys.map(key => <InfoCard key={key.id}>
        <Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>{key.name}</Text>
        <Text style={secondary}>{key.prefix}… · {key.revokedAt ? 'Revoked' : 'Active'}</Text><Text style={secondary}>{key.scopes.join(', ')}</Text>
        {!key.revokedAt ? <><Button label="Rotate key" variant="secondary" disabled={busy || !!token} onPress={() => confirmKeyChange(key, true)} /><Button label="Revoke key" variant="tertiary" disabled={busy || !!token} onPress={() => confirmKeyChange(key, false)} /></> : null}
      </InfoCard>)}
      <Button label="Refresh API keys" variant="tertiary" disabled={busy} onPress={() => void run(reloadKeys, true)} />
    </> : null}
    <Button label="Refresh workspaces" variant="tertiary" loading={busy} onPress={() => void run(reloadVisibleWorkspace)} />
    <SectionHeader title="First request" />
    <Text style={secondary}>Read your workspace’s Proofs from your server with a key that includes proofs:read. Create requests require proofs:write and an idempotency key. Capture and viewing links require the merchant’s PackProof sign-in.</Text>
    <Text selectable style={[typography.secondary, { color: colors.textPrimary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{'GET /v1/proofs\nAuthorization: Bearer YOUR_API_KEY'}</Text>
    <Button label="API documentation" variant="secondary" onPress={() => { setToken(null); void Linking.openURL(documentationUrl).catch(() => setError('The API documentation could not be opened. Try again.')); }} />
  </View>;
}
