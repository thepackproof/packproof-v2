import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { InfoCard } from '../ui/ProofCard';
import { ApiError } from '../v2-api';
import { IntakeApi, type IntakeAlias } from './api';
import type { IntakeCapabilities, IntakeDeviceCredentials } from './model';
import { forgetIntakeDevice, readIntakeDevice, saveIntakeDevice } from './storage';

const labels: Record<IntakeAlias['state'], string> = { AWAITING_VERIFICATION: 'Awaiting forwarding verification', AWAITING_VALID_SAMPLE: 'Awaiting a valid sales message', READY: 'Ready', REVOKED: 'Disconnected' };
export function IntakeSettings() {
  const app = usePackProof();
  const { colors } = useTheme();
  const [flags, setFlags] = useState<IntakeCapabilities | null>(null);
  const [device, setDevice] = useState<IntakeDeviceCredentials | null>(null);
  const [deviceState, setDeviceState] = useState('');
  const [aliases, setAliases] = useState<IntakeAlias[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const active = useRef(true);
  const userId = app.session?.userId;
  const owner = useRef(userId); owner.current = userId;
  const api = new IntakeApi(app.client);
  async function refresh() {
    if (!userId) return;
    const [capabilities, saved, mail] = await Promise.all([api.capabilities(), readIntakeDevice(app.client, userId), api.aliases()]);
    if (!active.current || owner.current !== userId) return;
    setFlags(capabilities); setDevice(saved); setAliases(mail.aliases);
    if (saved) {
      try { const current = await api.pending(saved); if (active.current && owner.current === userId) setDeviceState(current.device.state); }
      catch (reason) { if (active.current && owner.current === userId) setDeviceState(reason instanceof ApiError && [403, 410].includes(reason.status) ? 'AWAITING_APPROVAL' : 'UNAVAILABLE'); }
    }
  }
  async function perform(work: () => Promise<void>) {
    if (busy || !userId) return;
    setBusy(true); setError(null);
    try { await app.ensureAuth(); if (owner.current !== userId) return; await work(); }
    catch (reason) { if (active.current && owner.current === userId) setError(reason instanceof Error ? reason.message : 'This connection could not be updated. Try again.'); }
    finally { if (active.current && owner.current === userId) setBusy(false); }
  }
  useEffect(() => { active.current = true; void perform(refresh); return () => { active.current = false; }; }, [userId, app.client]);
  if (!flags) return error ? <Text accessibilityRole="alert" style={{ color: colors.textSecondary }}>Automatic order setup is unavailable right now.</Text> : null;
  const connections = app.connections.filter(row => row.status === 'ACTIVE' && ['ebay', 'etsy', 'shopify'].includes(row.provider));
  async function copy(value: string, label: string) { await Clipboard.setStringAsync(value); if (active.current) setCopied(label); }
  return <View style={styles.section}>
    {flags.handoffEnabled || device ? <InfoCard>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Recording phone</Text>
      <Text style={[styles.copy, { color: colors.textSecondary }]}>Send the order selected on your computer to this phone. Keep PackProof open on the Proofs screen to receive it.</Text>
      {device ? <>
        <Text style={[styles.copy, { color: colors.textPrimary }]}>{['APPROVED', 'ACTIVE'].includes(deviceState) ? 'This phone is paired.' : deviceState === 'UNAVAILABLE' ? 'Could not check pairing. Refresh when connected.' : 'Approve this phone in the web app’s Connections settings.'}</Text>
        {device.pairingCode && !['APPROVED', 'ACTIVE'].includes(deviceState) ? <><Text selectable style={[styles.code, { color: colors.textPrimary }]}>{device.pairingCode}</Text><Button label="Copy pairing code" variant="tertiary" onPress={() => void copy(device.pairingCode!, 'Pairing code copied')} /></> : null}
        <Button label="Check pairing" variant="secondary" loading={busy} onPress={() => void perform(refresh)} />
        <Button label="Disconnect this phone" variant="tertiary" disabled={busy} onPress={() => void perform(async () => { await api.revoke(device.deviceId); await forgetIntakeDevice(app.client, userId!); setDevice(null); setDeviceState(''); })} />
      </> : <Button label="Pair this recording phone" disabled={!flags.handoffEnabled} loading={busy} onPress={() => void perform(async () => { const created = await api.register(Platform.OS === 'android' ? 'Android recording phone' : 'Recording phone'); const saved = { deviceId: created.device.id, deviceToken: created.deviceToken, pairingCode: created.pairingCode }; await saveIntakeDevice(app.client, userId!, saved); setDevice(saved); setDeviceState(created.device.state); })} />}
    </InfoCard> : null}
    {flags.emailEnabled || aliases.length ? <InfoCard>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Automatic order inbox</Text>
      <Text style={[styles.copy, { color: colors.textSecondary }]}>Set up selective forwarding once. Supported sales emails then prepare orders here automatically.</Text>
      {!flags.mailDomainConfigured ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Receiving email is not available yet. Your connected-store orders continue to work.</Text> : null}
      {aliases.filter(row => row.state !== 'REVOKED').map(alias => <View key={alias.id} style={styles.section}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{alias.store} · {labels[alias.state]}</Text>
        <Text selectable style={[styles.copy, { color: colors.textPrimary }]}>{alias.address}</Text>
        <Button label="Copy forwarding address" variant="tertiary" onPress={() => void copy(alias.address, 'Forwarding address copied')} />
        {alias.state !== 'READY' ? <>
          <Text style={[styles.copy, { color: colors.textSecondary }]}>In Gmail on your computer, add this address under Settings → Forwarding and POP/IMAP. Keep forwarding disabled for all mail. Complete Google’s verification, then create a filter matching only this store’s sales notifications and forward those messages. Keep your original emails.</Text>
          {alias.challenge && Date.parse(alias.challenge.expiresAt) > Date.now() ? <>
            {alias.challenge.code ? <><Text selectable style={[styles.code, { color: colors.textPrimary }]}>{alias.challenge.code}</Text><Button label="Copy verification code" variant="tertiary" onPress={() => void copy(alias.challenge!.code!, 'Verification code copied')} /></> : null}
            {alias.challenge.url && /^https:\/\/(?:mail|accounts)\.google\.com\//i.test(alias.challenge.url) ? <Button label="Open Google verification" variant="secondary" onPress={() => void Linking.openURL(alias.challenge!.url!)} /> : null}
            <Button label="I completed Google verification" variant="secondary" disabled={busy} onPress={() => void perform(async () => { await api.verifyAlias(alias.id, alias.challenge!.id); await refresh(); })} />
          </> : null}
          <Text style={[styles.copy, { color: colors.textSecondary }]}>{alias.supportedTemplates.length ? 'Forward one detailed sales message to check its items, quantities, and store. Setup becomes Ready after a supported order is prepared.' : 'Sales-message validation is not enabled for this store yet. Setup will stay pending until a supported message template has been validated.'}</Text>
        </> : null}
        {alias.lastErrorCode ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.textSecondary }]}>The last message could not prepare a complete order. Check that it includes the order reference, purchased items, and quantities.</Text> : null}
        <Button label="Disconnect forwarding address" variant="tertiary" disabled={busy} onPress={() => void perform(async () => { await api.revokeAlias(alias.id); await refresh(); })} />
      </View>)}
      {connections.filter(row => !aliases.some(alias => alias.connectionId === row.connectionId && alias.state !== 'REVOKED')).map(row => <Button key={row.connectionId} label={`Set up email for ${row.providerDisplay}`} variant="secondary" disabled={busy || !flags.emailEnabled || !flags.mailDomainConfigured} onPress={() => void perform(async () => { await api.createAlias(row.connectionId); await refresh(); })} />)}
      {!connections.length ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Connect your selling account above to identify which store the forwarded orders belong to.</Text> : null}
      <Button label="Refresh inbox setup" variant="tertiary" loading={busy} onPress={() => void perform(refresh)} />
    </InfoCard> : null}
    {copied ? <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textSecondary }]}>{copied}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.textSecondary }]}>{error}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 12 }, title: { ...typography.bodyStrong }, copy: { ...typography.secondary }, code: { ...typography.pageTitle, letterSpacing: 3 } });
