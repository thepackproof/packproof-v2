import { useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { ETSY_ATTRIBUTION, SHOPIFY_AUTOMATIC_PROOFS_LABEL, orderIntakeExplanation } from '../copy/commerce';
import type { SalesChannel } from '../copy/sales-channels';
import { integrationPresentation } from '../experience/integration-presentation';
import { IntakeSettings } from '../intake/IntakeSettings';
import { useTheme } from '../theme/ThemeProvider';
import { taskFirstTypography as type } from '../theme/tokens';
import { Button } from './Button';
import { FormField } from './FormField';
import { BottomSheet } from './Sheets';
import { ErrorBanner } from './EmptyState';

export function AndroidIntegrations({ channels, renderAccounts }: {
  channels: SalesChannel[];
  renderAccounts: (channel: SalesChannel) => ReactNode;
}) {
  const app = usePackProof(), { colors } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [showIntake, setShowIntake] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [shop, setShop] = useState('');
  const [automatic, setAutomatic] = useState(true);
  const returnFocus = useRef<View | null>(null);
  const providerRefs = useRef<Record<string, View | null>>({});
  const providerRefCallbacks = useRef<Record<string, (node: View | null) => void>>({});
  function providerRef(provider: string) {
    return providerRefCallbacks.current[provider] ??= node => {
      const old = providerRefs.current[provider];
      providerRefs.current[provider] = node;
      if (!node && returnFocus.current === old) returnFocus.current = null;
    };
  }
  const { width, fontScale } = useWindowDimensions();
  const stackRows = width < 360 || fontScale >= 1.4;
  const channel = channels.find(row => row.provider === selected);
  const active = channels.filter(row => integrationPresentation(row).action);
  const unavailable = channels.filter(row => !integrationPresentation(row).action);
  const visible = [...active, ...(showUnavailable ? unavailable : [])];
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await Promise.all([app.loadConnections(), app.loadConnectedAccounts()]); }
    finally { setRefreshing(false); }
  }
  return <View style={styles.content}>
    <Text accessibilityRole="header" style={[type.sectionTitle, { color: colors.textPrimary }]}>Connect a selling account</Text>
    <Text style={[type.secondary, { color: colors.textSecondary }]}>Optional — you can create a Proof without a connection.</Text>
    <Button label="Create a Proof" variant="secondary" onPress={() => app.selectCreateProof()} />
    <View>
      {visible.map(row => {
        const state = integrationPresentation(row);
        return <View key={row.provider} style={[styles.row, { borderBottomColor: colors.border, flexDirection: stackRows ? 'column' : 'row', alignItems: stackRows ? 'stretch' : 'center' }]}>
          <View style={[styles.provider, stackRows ? undefined : { flex: 1 }]}>
          <View style={[styles.mark, { backgroundColor: colors.accentSoft }]} accessible={false}>
            <Text style={[type.rowTitle, { color: colors.accentText }]}>{row.provider === 'ebay' ? 'e' : row.providerDisplay.charAt(0)}</Text>
          </View>
          <View style={styles.copy}>
            <Text style={[type.rowTitle, { color: colors.textPrimary }]}>{row.providerDisplay}</Text>
            <Text style={[type.secondary, { color: state.status === 'Needs attention' ? colors.warningText : colors.textSecondary }]}>{state.status}</Text>
          </View>
          </View>
          {state.action ? <Pressable ref={providerRef(row.provider)}
            accessibilityRole="button" accessibilityLabel={`${state.action} ${row.providerDisplay}`} accessibilityState={{ disabled: app.busy }} disabled={app.busy}
            style={({ pressed }) => [styles.providerAction, { alignSelf: stackRows ? 'flex-start' : undefined, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
            onPress={() => { returnFocus.current = providerRefs.current[row.provider]; app.setError(null); setShop(''); setAutomatic(true); setSelected(row.provider); }}>
            <Text style={[type.button, { color: app.busy ? colors.disabledText : colors.accentText, flexShrink: 1 }]}>{state.action}</Text>
          </Pressable> : null}
        </View>;
      })}
    </View>
    {!channels.length ? <Text style={[type.secondary, { color: colors.textSecondary }]}>{app.busy || refreshing ? 'Loading selling accounts…' : 'Connections are not available yet. Refresh to check, or create a Proof without a connection.'}</Text> : null}
    {unavailable.length ? <Button label={`${showUnavailable ? 'Hide' : 'View'} unavailable providers (${unavailable.length})`} variant="tertiary" onPress={() => setShowUnavailable(!showUnavailable)} /> : null}
    <Button label="Refresh connections" variant="tertiary" loading={refreshing} disabled={app.busy} onPress={() => void refresh()} />
    <Button label={showIntake ? 'Hide order intake settings' : 'Order intake settings'} variant="tertiary" onPress={() => setShowIntake(!showIntake)} />
    {showIntake ? <IntakeSettings /> : null}
    <Text style={[type.secondary, { color: colors.textSecondary }]}>Marketplace authorization is separate from PackProof sign-in. Recording a Proof does not mark an order shipped.</Text>
    {channels.some(row => row.provider === 'etsy') ? <Text style={[type.secondary, { color: colors.textSecondary }]}>{ETSY_ATTRIBUTION}</Text> : null}
    <BottomSheet visible={Boolean(channel)} title={channel?.providerDisplay ?? 'Connection'} returnFocusRef={returnFocus} dismissible={!app.busy} onClose={() => setSelected(null)}>
      {channel ? <>
        <ErrorBanner message={app.error} />
        {app.offline ? <Text accessibilityLiveRegion="polite" style={[type.secondary, { color: colors.warningText }]}>Reconnect before connecting or updating a selling account.</Text> : null}
        {renderAccounts(channel)}
        {integrationPresentation(channel).canConnect ? <>
          {channel.catalog?.requiresShop ? <FormField label="Shopify shop" placeholder="your-store.myshopify.com" value={shop} onChangeText={setShop} autoCapitalize="none" /> : null}
          {channel.provider === 'shopify' ? <>
            <View style={styles.automation}><Text style={[type.body, styles.copy, { color: colors.textPrimary }]}>{SHOPIFY_AUTOMATIC_PROOFS_LABEL}</Text>
              <Switch accessibilityLabel={SHOPIFY_AUTOMATIC_PROOFS_LABEL} value={automatic} disabled={app.busy} onValueChange={setAutomatic} trackColor={{ true: colors.primary }} /></View>
            <Text style={[type.secondary, { color: colors.textSecondary }]}>{orderIntakeExplanation(channel.provider)}</Text>
          </> : null}
          <Button label={`${channel.accounts.length ? 'Connect another' : 'Connect'} ${channel.providerDisplay}`} loading={app.busy} disabled={app.offline || Boolean(channel.catalog?.requiresShop && !shop.trim())}
            onPress={() => void app.connectConnectedAccount(channel.provider, channel.provider === 'shopify' ? { shop: shop.trim(), autoSyncEnabled: automatic } : channel.catalog?.requiresShop ? { shop: shop.trim() } : undefined)} />
        </> : <Text style={[type.secondary, { color: colors.textSecondary }]}>{channel.catalog?.enabled
          ? 'Manage your existing connection here.'
          : 'New order connections are unavailable. Existing account records remain available here.'}</Text>}
        {channel.catalog?.limitations.map((limitation, index) => <Text key={index} style={[type.secondary, { color: colors.textSecondary }]}>{limitation}</Text>)}
        <View style={styles.automation}><Ionicons name="information-circle-outline" size={20} color={colors.textSecondary} /><Text style={[type.secondary, styles.copy, { color: colors.textSecondary }]}>Connecting never completes a Proof.</Text></View>
      </> : null}
    </BottomSheet>
  </View>;
}

const styles = StyleSheet.create({
  content: { gap: 12 }, row: { minHeight: 64, paddingVertical: 10, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  provider: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  providerAction: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8, justifyContent: 'center' },
  mark: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 3 }, automation: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
