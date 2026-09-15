import { proofReference, shipmentRecordLabel } from "../copy/evidence-record";
import { RecordThumbnail } from "../ui/RecordThumbnail";
import { RecordSeal } from "../ui/RecordSeal";
import { ReadyOrders } from "../intake/ReadyOrders";
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { localProofWork, mergeProofInvitations, presentationForProof, selectProofRows, type PresentedProof } from '../copy/proof-list';
import { formatDate } from '../copy/format';
import { Logo } from '../ui/Logo';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppScreen } from '../ui/AppScreen';
import { AvatarButton } from '../ui/AvatarButton';
import { BottomSheet } from '../ui/Sheets';
import { EmptyState, ErrorBanner, OfflineBanner } from '../ui/EmptyState';
import { ProofCardSkeleton } from '../ui/Skeleton';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/StatusBadge';
import { ProgressState } from '../ui/EvidenceCard';
import { FadeSlideIn, LiftPressable, PressableScale } from '../ui/motion';
import type { ProofCollectionItem, InvitationInboxView } from '../v2-api';

export function MyProofsScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const [filterOpen, setFilterOpen] = useState(false);
  const [preparedProofIds, setPreparedProofIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(!app.proofCollection.length);
  const [snapshot, setSnapshot] = useState<{ rows: ProofCollectionItem[]; invites: InvitationInboxView[] }>({ rows:app.proofCollection, invites:app.pendingInvites });
  const [requestedRefresh, setRequestedRefresh] = useState(false);
  const library = app.proofsLibrary;
  useEffect(() => {
    let alive = true;
    void app.run(app.syncWorkspace).finally(() => { if (alive) { setLoading(false); setRequestedRefresh(true); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (requestedRefresh || (!snapshot.rows.length && app.proofCollection.length && loading)) {
      setSnapshot({ rows:app.proofCollection, invites:app.pendingInvites });
      setRequestedRefresh(false);
    }
  }, [app.proofCollection, app.pendingInvites, requestedRefresh, loading]);
  const presentedRows = useMemo(() => mergeProofInvitations(snapshot.rows.map(row => app.proofCollection.find(current => current.proofId === row.proofId) ?? row), snapshot.invites).map(item => {
    const capture = app.savedRecordings.find(row => row.captureProofId === item.proofId && row.recovery?.phase !== 'FINALIZED')
      ?? (app.session?.captureProofId === item.proofId ? app.localCapture : null);
    const uploading = Object.prototype.hasOwnProperty.call(app.uploadProgressByProof, item.proofId);
    return { ...item, presentation:presentationForProof(item, item.role, localProofWork(capture, uploading ? 'uploading' : app.session?.captureProofId === item.proofId ? app.captureStatus : undefined, uploading ? app.uploadProgressByProof[item.proofId] : undefined)) };
  }), [snapshot, library, app.proofCollection, app.savedRecordings, app.localCapture, app.captureStatus, app.uploadPercent, app.uploadProgressByProof]);
  const sortedRows = selectProofRows(presentedRows,library);
  const order = useRef<{ snapshot:typeof snapshot; filters:string; ids:string[] } | null>(null);
  const filterKey = JSON.stringify(library);
  if (!order.current || order.current.snapshot !== snapshot || order.current.filters !== filterKey) order.current = {snapshot,filters:filterKey,ids:sortedRows.map(row => row.proofId)};
  const rows = order.current.ids.map(id => presentedRows.find(row => row.proofId === id)).filter((row):row is PresentedProof => Boolean(row));
  const changed = sortedRows.map(row=>row.proofId).join("|") !== order.current.ids.join("|") || app.proofCollection.map(row => `${row.proofId}:${row.updatedAt}:${row.presentation?.displayStatus}`).join('|') !== snapshot.rows.map(row => `${row.proofId}:${row.updatedAt}:${row.presentation?.displayStatus}`).join('|');
  async function refresh() { await app.run(app.syncWorkspace); setRequestedRefresh(true); }
  async function open(item: PresentedProof, act = false) {
    if (item.accessKind === "RECEIVER") { app.openReceipt(item.proofId); return; }
    if (item.invitationId) {
      const invitation = app.pendingInvites.find(row => row.invitationId === item.invitationId);
      if (invitation) app.openInvitation(invitation);
      else await app.acceptInvite(item.invitationId);
      return;
    }
    const work = app.savedRecordings.find(row => row.captureProofId === item.proofId && !['FINALIZED','SUBMITTED'].includes(row.recovery?.phase ?? ''));
    if (act && work && ['RESUME_UPLOAD','REVIEW_CONFIRM','RECOVER_RECORDING'].includes(item.presentation.nextAction.type)) {
      if (work.recovery?.phase === "RECORDING") { app.go("account", {accountSection:"recordings"}); return; }
      await app.resumeSavedCapture(work); return;
    }
    await app.run(async () => {
      await app.openProof(item.proofId);
      if (!act) return;
      if (item.presentation.nextAction.type === 'RECORD_PACKING') app.go('capture');
      else if (item.presentation.nextAction.type === 'REVIEW_CONFIRM') app.go('finalize');
      else if (item.presentation.nextAction.type === 'WORKFLOW_ACTION' && item.status === 'FINALIZED') app.openReceipt(item.proofId);
    });
  }
  const noMatches = Boolean(library.query.trim() || library.role !== 'all' || library.carrier);
  const emptyTitle = noMatches ? 'No search matches' : library.view === 'attention' ? 'Nothing needs your attention' : library.view === 'completed' ? 'No completed Proofs yet' : 'No Proofs yet';
  return <AppScreen key={app.session?.userId} restorationReady={!loading} resetScrollKey={filterKey} onRefresh={() => void refresh()} refreshing={app.busy} initialOffsetY={app.readProofsScrollOffset()} onScrollOffset={app.setProofsScrollOffset}>
    <View style={styles.topBar}>
      <View style={styles.brand} accessibilityLabel="PackProof"><Logo size={32} /><Text style={[styles.brandText,{color:colors.textPrimary}]}>Pack<Text style={{color:colors.logoGreen}}>Proof</Text></Text></View>
      <AvatarButton displayName={app.session?.displayName} username={app.session?.username} onPress={() => app.go('account')} />
    </View>
    <View style={styles.heading}><Text style={[styles.pageTitle, { color:colors.textPrimary }]}>Proofs</Text><Button label="New Proof" icon="add-outline" onPress={() => app.go('create')} /></View>
    <View style={[styles.tabs, { borderBottomColor:colors.divider }]} accessibilityRole="tablist" accessibilityLabel="Filter Proofs">
      {([{id:'attention',label:'Needs attention'},{id:'all',label:'All'},{id:'completed',label:'Completed'}] as const).map(option => <PressableScale key={option.id} onPress={() => app.setProofsView(option.id)} accessibilityRole="tab" accessibilityState={{ selected:library.view === option.id }} style={[styles.tab, { backgroundColor: library.view === option.id ? colors.surfaceElevated : 'transparent' }]}><Text style={[styles.tabText,{color:library.view === option.id ? colors.textPrimary : colors.textSecondary}]}>{option.label}</Text></PressableScale>)}
    </View>
    <View style={styles.searchRow}>
      <View style={[styles.search,{borderColor:colors.controlBorder,backgroundColor:colors.surface}]}><Ionicons name="search-outline" size={20} color={colors.textSecondary}/><TextInput value={library.query} onChangeText={app.setProofsQuery} placeholder="Search Proofs" placeholderTextColor={colors.textSecondary} accessibilityLabel="Search Proofs" autoCapitalize="none" autoCorrect={false} style={[styles.input,{color:colors.textPrimary}]}/></View>
      <PressableScale onPress={() => setFilterOpen(true)} accessibilityRole="button" accessibilityLabel="Filters" style={[styles.filter,{borderColor:colors.controlBorder}]}><Ionicons name="options-outline" size={22} color={colors.textPrimary}/></PressableScale>
    </View>
    <OfflineBanner visible={app.offline} />
    <ErrorBanner message={app.error || (app.offline && !snapshot.rows.length ? "Proofs could not be loaded while offline. Reconnect and try again." : null)}/>
    {app.error || (app.offline && !snapshot.rows.length) ? <Button label="Try loading Proofs again" variant="tertiary" onPress={() => void refresh()} /> : null}
    {library.view !== "completed" && !library.query.trim() ? <ReadyOrders onPreparedProofsChange={setPreparedProofIds} /> : null}
    {changed && !loading ? <Button label="Updates available · Refresh" variant="tertiary" onPress={() => setRequestedRefresh(true)} /> : null}
    {loading && !rows.length && !app.error ? <><ProofCardSkeleton/><ProofCardSkeleton/></> : null}
    {rows.filter(item => !preparedProofIds.includes(item.proofId)).map((item, index) => {
      return <FadeSlideIn key={item.proofId} index={index}>
        <View style={[styles.row,{backgroundColor:colors.surface,borderColor:colors.border}]}>
          <LiftPressable onPress={() => void open(item)} accessibilityRole="button" accessibilityLabel={`${item.transaction.itemTitle || 'Shipment Proof'}. ${item.presentation.displayStatus}. Open Proof`} style={styles.rowCopy}>
            <View style={styles.recordHeading}><RecordThumbnail key={`${app.session?.userId}:${item.proofId}:${item.thumbnailDerivativeId}`} proofId={item.proofId} derivativeId={item.thumbnailDerivativeId} /><View style={{flex:1,gap:6}}>
            <Text style={[styles.rowTitle,{color:colors.textPrimary}]}>{item.transaction.itemTitle || 'Shipment Proof'}</Text>
            <Text style={[styles.meta,{color:colors.textSecondary}]}>{proofReference(item.proofId,item.transaction.externalReference)}</Text>
            </View><Ionicons name="chevron-forward" size={18} color={colors.textSecondary}/></View>
            <RecordSeal status={item.status}/>
            <View style={styles.shipmentLine}><Ionicons name="navigate-outline" size={15} color={colors.textSecondary}/><Text style={[styles.meta,{color:colors.textSecondary,flexShrink:1}]}>Shipment: {shipmentRecordLabel(item.transaction.trackingNumber,item.presentation.shipmentStatus)}</Text></View>
            {item.presentation.needsAttention ? <StatusBadge label={item.presentation.displayStatus}/> : null}
            {Object.prototype.hasOwnProperty.call(app.uploadProgressByProof, item.proofId) ? <View style={{ gap: 8 }}>
              <ProgressState label="Recording upload" showLabel={false} percent={app.uploadProgressByProof[item.proofId]} />
              <Text style={[typography.finePrint, { color: colors.textSecondary }]}>Upload continues while you work on the next Proof.</Text>
            </View> : null}
            <Text style={[styles.meta,{color:colors.textSecondary}]}>{[item.transaction.provider, `Updated ${formatDate(item.updatedAt)}`].filter(Boolean).join(' · ')}</Text>
          </LiftPressable>
          {item.presentation.needsAttention ? <Button label={item.presentation.nextAction.label} variant="tertiary" onPress={() => void open(item,true)} loading={app.busy} /> : null}
        </View>
      </FadeSlideIn>;
    })}
    {!loading && !app.error && !app.offline && !rows.length && !preparedProofIds.length ? <EmptyState title={emptyTitle} body={noMatches ? 'Try another reference or clear your filters.' : library.view === 'attention' ? 'Waiting and uploading Proofs are still available in All.' : library.view === 'completed' ? 'Proofs appear here when their evidence is finalized. Delivery is tracked separately.' : 'Connected-store orders appear here automatically. Use New Proof for another shipment.'} actionLabel={noMatches ? 'Clear search and filters' : library.view !== 'all' ? 'View all Proofs' : undefined} onAction={noMatches ? () => { app.setProofsQuery('');app.setProofsRoleFilter('all');app.setProofsCarrierFilter(null); } : () => app.setProofsView('all')} /> : null}
    <BottomSheet visible={filterOpen} title="Filters" onClose={() => setFilterOpen(false)}>
      <Text style={[styles.rowTitle,{color:colors.textPrimary}]}>Your role</Text>
      {(['all','seller','buyer'] as const).map(role => <Button key={role} label={`${library.role === role ? '✓ ' : ''}${role === 'all' ? 'All roles' : role === 'seller' ? 'Seller' : 'Buyer'}`} variant="tertiary" onPress={() => app.setProofsRoleFilter(role)} />)}
      <Button label="Done" onPress={() => setFilterOpen(false)} />
    </BottomSheet>
  </AppScreen>;
}
const styles = StyleSheet.create({
  recordHeading:{flexDirection:'row',gap:14,alignItems:'center'},shipmentLine:{flexDirection:'row',gap:7,alignItems:'center'},
  topBar:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:16},brand:{flexDirection:'row',alignItems:'center',gap:8},brandText:{...typography.sectionTitle,fontSize:22,lineHeight:30},
  heading:{flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:12},pageTitle:{...typography.pageTitle},
  tabs:{flexDirection:'row',flexWrap:'wrap',gap:4},tab:{minHeight:48,paddingHorizontal:10,paddingVertical:10,borderRadius:12,justifyContent:'center'},tabText:{...typography.secondaryStrong},
  searchRow:{flexDirection:'row',gap:8},search:{flex:1,minHeight:48,flexDirection:'row',alignItems:'center',paddingHorizontal:12,borderWidth:1,borderRadius:8,gap:8},input:{flex:1,...typography.body,paddingVertical:8},filter:{minWidth:48,minHeight:48,alignItems:'center',justifyContent:'center',borderWidth:1,borderRadius:8},
  row:{marginBottom:4,padding:16,borderWidth:0,borderRadius:16,gap:8},rowCopy:{gap:6,minHeight:48},rowTitle:{...typography.bodyStrong,fontSize:18,lineHeight:25},meta:{...typography.secondary},status:{...typography.secondaryStrong},
});
