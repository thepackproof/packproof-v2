import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import type { ProofsLibraryView } from '../app/navigation';
import type { FulfillmentQueueItem } from '../v2-api';
import type { PresentedProof } from '../copy/proof-list';
import { pendingWorkspaceRecordings, readyWorkspaceOrders, recentWorkspaceProofs, workspaceProofRows } from '../copy/workspace-summary';
import { formatDate } from '../copy/format';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { TutorialTarget } from '../onboarding/Onboarding';
import { AppScreen } from '../ui/AppScreen';
import { WorkspaceHeader } from '../ui/WorkspaceHeader';
import { Button } from '../ui/Button';
import { ErrorBanner, OfflineBanner } from '../ui/EmptyState';
import { PressableScale } from '../ui/motion';

export function WorkspaceHomeScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const alive = useRef(false);
  const refreshGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const scope = `${app.session?.apiBaseUrl || ''}:${app.session?.userId || ''}`;
  const [queueSnapshot, setQueueSnapshot] = useState<{scope:string;items:FulfillmentQueueItem[]} | null>(null);
  const queue = queueSnapshot?.scope === scope ? queueSnapshot.items : null;
  const [queueError, setQueueError] = useState<string | null>(null);
  async function refresh() {
    const account = app.session;
    if (!account) return;
    const generation = ++refreshGeneration.current;
    const current = () => alive.current && refreshGeneration.current === generation;
    setLoading(true);
    setQueueError(null);
    await app.run(async () => {
      app.client.assertCaptureAccount(account.userId, account.apiBaseUrl);
      await app.syncWorkspace();
      if (!current()) return;
      try {
        app.client.assertCaptureAccount(account.userId, account.apiBaseUrl);
        const result = await app.client.listFulfillmentQueue('ready');
        if (!current()) return;
        app.client.assertCaptureAccount(account.userId, account.apiBaseUrl);
        setQueueSnapshot({scope:`${account.apiBaseUrl}:${account.userId}`,items:result.items});
      } catch {
        if (current()) { setQueueSnapshot(null); setQueueError('Orders could not be refreshed. Open Orders or try again.'); }
      }
    });
    if (current()) setLoading(false);
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; refreshGeneration.current++; };
  }, [app.session?.apiBaseUrl, app.session?.userId]);
  const rows = useMemo(() => workspaceProofRows({
    proofs: app.proofCollection, invitations: app.pendingInvites,
    recordings: app.savedRecordings, localCapture: app.localCapture,
    captureProofId: app.session?.captureProofId, captureStatus: app.captureStatus,
    uploadProgressByProof: app.uploadProgressByProof,
  }), [app.proofCollection, app.pendingInvites, app.savedRecordings, app.localCapture, app.session?.captureProofId, app.captureStatus, app.uploadProgressByProof]);
  const recent = recentWorkspaceProofs(rows);
  const pending = pendingWorkspaceRecordings(app.savedRecordings, app.localCapture);
  const readyOrders = queue ? readyWorkspaceOrders(queue, app.proofCollection, app.savedRecordings, app.localCapture) : null;
  const unavailable = loading || (!rows.length && (Boolean(app.error) || app.offline));
  const count = (value: number) => unavailable ? '—' : String(value);
  function openLibrary(view: ProofsLibraryView = 'all') {
    app.setProofsView(view); app.setProofsQuery(''); app.setProofsRoleFilter('all'); app.setProofsCarrierFilter(null); app.go('proofs');
  }
  function openProof(item: PresentedProof) {
    if (item.accessKind === 'RECEIVER') { app.openReceipt(item.proofId); return; }
    if (item.invitationId) {
      const invitation = app.pendingInvites.find(invite => invite.invitationId === item.invitationId);
      if (invitation) app.openInvitation(invitation);
      else void app.acceptInvite(item.invitationId);
      return;
    }
    void app.run(() => app.openProof(item.proofId));
  }
  const link = (label: string, onPress: () => void) => <PressableScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.textAction}><Text style={[styles.textActionLabel,{color:colors.accentText}]}>{label}</Text><Ionicons name="arrow-forward" size={14} color={colors.accentText} /></PressableScale>;
  function metric(label: string, value: string, detail: string, onPress: () => void, target = '') {
    return <View style={styles.metricWrap}><TutorialTarget name={target}><PressableScale accessibilityRole="button" accessibilityLabel={`${label}: ${value}. ${detail}`} onPress={onPress} style={[styles.metric,{backgroundColor:colors.surface,borderColor:colors.border}]}><Text style={[styles.metricLabel,{color:colors.textSecondary}]}>{label}</Text><Text style={[styles.metricValue,{color:colors.textPrimary}]}>{value}</Text><Text style={[styles.metricDetail,{color:colors.textMuted}]}>{detail}</Text></PressableScale></TutorialTarget></View>;
  }
  function statusRow(label: string, content: ReactNode, last = false) {
    return <View style={[styles.statusRow,{borderBottomColor:colors.divider,borderBottomWidth:last ? 0 : 1}]}><Text style={[styles.statusLabel,{color:colors.textSecondary}]}>{label}</Text>{content}</View>;
  }
  return <AppScreen onRefresh={() => void refresh()} refreshing={loading}>
    <WorkspaceHeader section="Home" />
    <View style={styles.heading}><View style={styles.headingCopy}><Text style={[styles.eyebrow,{color:colors.textMuted}]}>PACKPROOF WORKSPACE</Text><Text style={[styles.title,{color:colors.textPrimary}]}>Home</Text></View><TutorialTarget name="create"><Button label="New Proof" icon="add-outline" onPress={() => app.go('create')} /></TutorialTarget></View>
    <Text style={[styles.subtitle,{color:colors.textSecondary}]}>Your fulfillment desk, at a glance.</Text>
    <OfflineBanner visible={app.offline} />
    <ErrorBanner message={app.error} />
    {app.error ? <Button label="Refresh workspace" variant="secondary" onPress={() => void refresh()} /> : null}
    <View style={[styles.hero,{backgroundColor:colors.accentSoft,borderColor:colors.accentSoftBorder}]}>
      <View style={styles.heroTop}><View style={styles.heroCopy}><Text style={[styles.eyebrow,{color:colors.accentText}]}>YOUR NEXT SHIPMENT</Text><Text style={[styles.heroTitle,{color:colors.textPrimary}]}>Ready at the packing table.</Text></View><View style={[styles.heroSymbol,{borderColor:colors.accentSoftBorder}]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Ionicons name="cube-outline" size={35} color={colors.accentText} /></View></View>
      <Text style={[styles.heroDescription,{color:colors.textSecondary}]}>Select an order. Record packing. Follow its upload through confirmation.</Text>
      <TutorialTarget name="capture"><View style={styles.heroAction}><Button label="Open Packing Station" icon="arrow-forward-outline" onPress={() => app.go('station')} /></View></TutorialTarget>
    </View>
    <View style={styles.metrics}>
      {metric('Needs attention', count(rows.filter(item => item.presentation.needsAttention).length), 'Records requiring an action', () => openLibrary('attention'), 'attention')}
      {metric('Ready to fulfill', loading || !readyOrders ? '—' : String(readyOrders.length), 'Synchronized marketplace orders', () => app.go('orders'))}
      {metric('Pending recordings', String(pending), 'Waiting for confirmation', () => app.go('account', {accountSection:'recordings'}))}
      {metric('Completed Proofs', count(rows.filter(item => item.presentation.completed).length), 'Finalized shipment records', () => openLibrary('completed'))}
    </View>
    <TutorialTarget name="proofs"><View style={[styles.panel,{backgroundColor:colors.surface,borderColor:colors.border}]}>
      <View style={styles.panelHeading}><Text style={[styles.panelTitle,{color:colors.textPrimary}]}>Recent Proofs</Text>{link('View all', () => openLibrary())}</View>
      <View style={[styles.tableHeading,{backgroundColor:colors.surfaceElevated,borderColor:colors.border}]}><Text style={[styles.columnLabel,{color:colors.textMuted}]}>SHIPMENT</Text><Text style={[styles.columnLabel,{color:colors.textMuted}]}>STATUS / UPDATED</Text></View>
      {loading && !recent.length ? <Text accessibilityRole="progressbar" style={[styles.loading,{color:colors.textMuted}]}>Loading Proofs…</Text> : recent.length ? recent.map(item => <PressableScale key={item.proofId} accessibilityRole="button" accessibilityLabel={`${item.transaction.itemTitle || 'Shipment Proof'}. ${item.presentation.displayStatus}. Open Proof`} onPress={() => openProof(item)} style={[styles.proofRow,{borderBottomColor:colors.divider}]}><View style={styles.proofCopy}><Text style={[styles.proofTitle,{color:colors.textPrimary}]} numberOfLines={2}>{item.transaction.itemTitle || item.transaction.externalReference || 'Shipment Proof'}</Text>{item.transaction.externalReference ? <Text style={[styles.proofReference,{color:colors.textSecondary}]} numberOfLines={1}>{item.transaction.externalReference}</Text> : null}<View style={[styles.badge,{backgroundColor:item.presentation.completed ? colors.successSoft : item.presentation.needsAttention ? colors.warningSoft : colors.accentSoft}]}><Text style={[styles.badgeLabel,{color:item.presentation.completed ? colors.successText : item.presentation.needsAttention ? colors.warningText : colors.accentText}]}>{item.presentation.displayStatus}</Text></View></View><View style={styles.proofTrailing}><Text style={[styles.date,{color:colors.textMuted}]}>{formatDate(item.updatedAt)}</Text><Ionicons name="arrow-forward" size={17} color={colors.textSecondary}/></View></PressableScale>) : <View style={styles.empty}><Ionicons name="document-text-outline" size={28} color={colors.textMuted}/><Text style={[styles.emptyTitle,{color:colors.textPrimary}]}>{app.error || app.offline ? 'Proofs unavailable' : 'No Proofs yet'}</Text><Text style={[styles.emptyBody,{color:colors.textSecondary}]}>{app.error || app.offline ? 'Reconnect and refresh your workspace to load your records.' : 'Create a Proof to start documenting a shipment.'}</Text></View>}
    </View></TutorialTarget>
    <TutorialTarget name="status"><View style={[styles.panel,{backgroundColor:colors.surface,borderColor:colors.border}]}>
      <View style={styles.panelHeading}><Text style={[styles.panelTitle,{color:colors.textPrimary}]}>Workspace status</Text></View>
      <View style={styles.statusList}>
        {statusRow('Connection', <View style={[styles.badge,{backgroundColor:app.offline || app.error ? colors.warningSoft : colors.surfaceElevated}]}><Text style={[styles.badgeLabel,{color:app.offline || app.error ? colors.warningText : colors.textSecondary}]}>{app.offline ? 'Offline' : loading ? 'Checking…' : app.error ? 'Needs attention' : 'Online'}</Text></View>)}
        {statusRow('Local recordings', link(`${pending} pending`, () => app.go('account', {accountSection:'recordings'})))}
        {statusRow('Packing Station', link('Open station', () => app.go('station')))}
        {statusRow('Marketplaces', link('Manage integrations', () => app.go('account', {accountSection:'channels'})), true)}
        <View style={[styles.quietNote,{backgroundColor:colors.surfaceElevated}]}><Ionicons name="shield-outline" size={17} color={colors.textMuted}/><Text style={[styles.quietNoteText,{color:colors.textMuted}]}>Upload progress is separate from Proof status. PackProof confirms when evidence has been received.</Text></View>
      </View>
    </View></TutorialTarget>
    <View style={[styles.panel,{backgroundColor:colors.surface,borderColor:colors.border}]}>
      <View style={styles.panelHeading}><Text style={[styles.panelTitle,{color:colors.textPrimary}]}>Fulfillment queue</Text>{link('View orders', () => app.go('orders'))}</View>
      {queueError ? <View style={styles.empty}><Text style={[styles.emptyBody,{color:colors.textSecondary}]}>{queueError}</Text><Button label="Try again" variant="secondary" onPress={() => void refresh()} /></View> : loading && !queue ? <Text style={[styles.loading,{color:colors.textMuted}]}>Loading orders…</Text> : readyOrders?.length ? readyOrders.slice(0,3).map(order => <PressableScale key={order.proofId} accessibilityRole="button" accessibilityLabel={`${order.itemSummary}. Open Proof`} onPress={() => void app.run(() => app.openProof(order.proofId))} style={[styles.proofRow,{borderBottomColor:colors.divider}]}><View style={styles.proofCopy}><Text style={[styles.proofTitle,{color:colors.textPrimary}]}>{order.externalReference || order.externalOrderId}</Text><Text style={[styles.proofReference,{color:colors.textSecondary}]}>{order.itemSummary}</Text><Text style={[styles.date,{color:colors.textMuted}]}>{order.providerDisplay}</Text></View><Ionicons name="arrow-forward" size={17} color={colors.textSecondary}/></PressableScale>) : queue ? <View style={styles.empty}><Ionicons name="cube-outline" size={29} color={colors.textMuted}/><Text style={[styles.emptyTitle,{color:colors.textPrimary}]}>No orders in this view</Text><Text style={[styles.emptyBody,{color:colors.textSecondary}]}>Connected marketplace orders appear here after they are synchronized.</Text>{link('Manage integrations', () => app.go('account',{accountSection:'channels'}))}</View> : <Text style={[styles.loading,{color:colors.textMuted}]}>Refresh your workspace to load orders.</Text>}
    </View>
  </AppScreen>;
}

const styles = StyleSheet.create({
  heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:12},headingCopy:{gap:5},eyebrow:{...typography.finePrint,fontFamily:'Inter-SemiBold',fontSize:10,lineHeight:15,letterSpacing:1.1},title:{...typography.pageTitle,fontSize:29,lineHeight:36},subtitle:{...typography.secondary,fontSize:14,marginTop:-8},
  hero:{borderWidth:1,borderRadius:10,padding:20,gap:14},heroTop:{flexDirection:'row',alignItems:'center',gap:16},heroCopy:{flex:1,gap:8},heroTitle:{...typography.sectionTitle,fontSize:23,lineHeight:29},heroDescription:{...typography.secondary,fontSize:14,lineHeight:22},heroAction:{alignSelf:'flex-start'},heroSymbol:{width:60,height:60,borderRadius:30,borderWidth:1,alignItems:'center',justifyContent:'center'},
  metrics:{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',gap:12},metricWrap:{flexBasis:'46%',flexGrow:1},metric:{minHeight:145,borderWidth:1,borderRadius:9,padding:15,gap:7},metricLabel:{...typography.secondaryStrong,fontSize:14,lineHeight:20},metricValue:{...typography.pageTitle,fontSize:30,lineHeight:37},metricDetail:{...typography.finePrint,fontSize:12,lineHeight:18},
  panel:{borderWidth:1,borderRadius:10,overflow:'hidden'},panelHeading:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:10,paddingHorizontal:17,paddingVertical:11},panelTitle:{...typography.cardTitle,fontSize:15,lineHeight:22,flexShrink:1},textAction:{minHeight:48,flexDirection:'row',alignItems:'center',gap:6,paddingVertical:7,flexShrink:1},textActionLabel:{...typography.secondaryStrong,fontSize:12,lineHeight:18,flexShrink:1},
  tableHeading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:17,paddingVertical:10,borderTopWidth:1,borderBottomWidth:1,gap:10},columnLabel:{...typography.finePrint,fontSize:12,lineHeight:18,letterSpacing:.35},proofRow:{flexDirection:'row',alignItems:'center',gap:14,paddingHorizontal:17,paddingVertical:17,borderBottomWidth:1},proofCopy:{flex:1,gap:5},proofTitle:{...typography.bodyStrong,fontSize:14,lineHeight:21},proofReference:{...typography.finePrint,fontSize:12,lineHeight:18},proofTrailing:{alignItems:'flex-end',gap:12,maxWidth:90},date:{...typography.finePrint,fontSize:12,lineHeight:18},badge:{alignSelf:'flex-start',borderRadius:4,paddingHorizontal:7,paddingVertical:4,marginTop:3,maxWidth:'100%'},badgeLabel:{...typography.secondaryStrong,fontSize:12,lineHeight:18,flexShrink:1},
  statusList:{paddingHorizontal:17,paddingBottom:17},statusRow:{minHeight:49,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:14},statusLabel:{...typography.finePrint,fontSize:14,flexShrink:1},quietNote:{flexDirection:'row',gap:10,alignItems:'flex-start',padding:12,borderRadius:6,marginTop:12},quietNoteText:{...typography.finePrint,fontSize:12,lineHeight:19,flex:1},
  loading:{...typography.secondary,fontSize:14,padding:22},empty:{alignItems:'center',paddingHorizontal:22,paddingVertical:28,gap:10},emptyTitle:{...typography.cardTitle,fontSize:15},emptyBody:{...typography.secondary,fontSize:14,lineHeight:22,textAlign:'center'},
});
