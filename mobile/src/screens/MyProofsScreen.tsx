import { TutorialTarget } from "../onboarding/Onboarding";
import { proofReference, shipmentRecordLabel } from "../copy/evidence-record";
import { RecordThumbnail } from "../ui/RecordThumbnail";
import { RecordSeal } from "../ui/RecordSeal";
import { ReadyOrders } from "../intake/ReadyOrders";
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { localProofWork, mergeProofInvitations, presentationForProof, selectProofRows, type PresentedProof } from '../copy/proof-list';
import { formatDate } from '../copy/format';
import { typography } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppScreen } from '../ui/AppScreen';
import { WorkspaceHeader } from '../ui/WorkspaceHeader';
import { BottomSheet } from '../ui/Sheets';
import { EmptyState, ErrorBanner, OfflineBanner } from '../ui/EmptyState';
import { ProofCardSkeleton } from '../ui/Skeleton';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/StatusBadge';
import { ProgressState } from '../ui/EvidenceCard';
import { FadeSlideIn, LiftPressable, PressableScale } from '../ui/motion';
import type { ProofCollectionItem, InvitationInboxView } from '../v2-api';
import { MOBILE_TASK_UX_ENABLED } from '../experience/mobile-ux';
import { nativeHomeInput } from '../experience/home-adapter';
import { selectTaskHome } from '../experience/task-home';
import { workspaceRecordings } from '../copy/workspace-summary';
import { captureRecoveryLabel } from '../capture/recovery-model';

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
  const presentedRows = useMemo(() => {
    const proofs = snapshot.rows.map(row => app.proofCollection.find(current => current.proofId === row.proofId) ?? row);
    // Classify the last known snapshot consistently with Home; the action router still reconciles on tap.
    const actionable = MOBILE_TASK_UX_ENABLED ? new Map(selectTaskHome(nativeHomeInput({ proofs, invitations: snapshot.invites, captures: workspaceRecordings(app.savedRecordings, app.localCapture), orders: [], progress: app.uploadProgressByProof, userId: app.session?.userId ?? '', apiBaseUrl: app.apiBaseUrl, online: true, reconciled: true })).actions.map(action => [action.targetId, action])) : null;
    return mergeProofInvitations(proofs, snapshot.invites).map(item => {
    const capture = app.savedRecordings.find(row => row.captureProofId === item.proofId && row.recovery?.phase !== 'FINALIZED')
      ?? (app.session?.captureProofId === item.proofId ? app.localCapture : null);
    const uploading = Object.prototype.hasOwnProperty.call(app.uploadProgressByProof, item.proofId);
    const presentation = { ...presentationForProof(item, item.role, localProofWork(capture, uploading ? 'uploading' : app.session?.captureProofId === item.proofId ? app.captureStatus : undefined, uploading ? app.uploadProgressByProof[item.proofId] : undefined)) };
    if (actionable) {
      const action = actionable.get(item.proofId);
      presentation.needsAttention = Boolean(action);
      if (action) presentation.nextAction = { type: presentation.nextAction.type, label: action.buttonLabel };
      if (action?.kind === 'reconcile') presentation.displayStatus = 'Status needs refresh';
      if (!action && capture?.recovery && !['FINALIZED', 'SUBMITTED'].includes(capture.recovery.phase)) {
        presentation.displayStatus = app.offline && ['LOCAL_ONLY', 'UPLOAD_QUEUED'].includes(capture.recovery.phase) ? 'Waiting for connection' : captureRecoveryLabel(capture.recovery.phase);
      }
    }
    return { ...item, presentation };
  }); }, [snapshot, library, app.proofCollection, app.savedRecordings, app.localCapture, app.captureStatus, app.uploadPercent, app.uploadProgressByProof, app.offline, app.session?.userId, app.apiBaseUrl]);
  const sortedRows = selectProofRows(presentedRows,library);
  const order = useRef<{ snapshot:typeof snapshot; filters:string; ids:string[] } | null>(null);
  const filterKey = JSON.stringify(library);
  if (!order.current || order.current.snapshot !== snapshot || order.current.filters !== filterKey) order.current = {snapshot,filters:filterKey,ids:sortedRows.map(row => row.proofId)};
  const rows = order.current.ids.map(id => presentedRows.find(row => row.proofId === id)).filter((row):row is PresentedProof => Boolean(row));
  const showPrepared = !MOBILE_TASK_UX_ENABLED && library.view !== 'completed' && !library.query.trim();
  const visiblePreparedIds = new Set(showPrepared ? preparedProofIds : []);
  const libraryRows = rows.filter(item => !visiblePreparedIds.has(item.proofId));
  const visibleCount = new Set([...visiblePreparedIds, ...libraryRows.map(item => item.proofId)]).size;
  const changed = sortedRows.map(row=>row.proofId).join("|") !== order.current.ids.join("|") || app.proofCollection.map(row => `${row.proofId}:${row.updatedAt}:${row.presentation?.displayStatus}`).join('|') !== snapshot.rows.map(row => `${row.proofId}:${row.updatedAt}:${row.presentation?.displayStatus}`).join('|');
  async function refresh() { await app.run(app.syncWorkspace); setRequestedRefresh(true); }
  async function open(item: PresentedProof, act = false) {
    if (MOBILE_TASK_UX_ENABLED && act) { await app.openProofAction(item.proofId); return; }
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
  return <AppScreen key={app.session?.userId} bottomInset={!MOBILE_TASK_UX_ENABLED} restorationReady={!loading} resetScrollKey={filterKey} onRefresh={() => void refresh()} refreshing={app.busy} initialOffsetY={app.readProofsScrollOffset()} onScrollOffset={app.setProofsScrollOffset}>
    <WorkspaceHeader section="Proofs" />
    <View style={styles.heading}><View style={styles.headingCopy}>{!MOBILE_TASK_UX_ENABLED ? <Text style={[styles.eyebrow,{color:colors.textMuted}]}>YOUR WORKSPACE</Text> : null}<Text accessibilityRole="header" style={[styles.pageTitle, MOBILE_TASK_UX_ENABLED && styles.mobileTitle, { color:colors.textPrimary }]}>Proofs</Text></View><TutorialTarget name="create capture"><Button label="Create Proof" icon="add-outline" onPress={() => app.go('create')} /></TutorialTarget></View>
    {!MOBILE_TASK_UX_ENABLED ? <Text style={[styles.subtitle,{color:colors.textSecondary}]}>Shipment evidence, organized and ready to review.</Text> : null}
    <View style={[styles.libraryPanel,{backgroundColor:colors.surface,borderColor:colors.border}]}>
    <View style={styles.toolbar}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} accessibilityRole="tablist" accessibilityLabel="Filter Proofs">
      {([{id:'all',label:'All'},{id:'attention',label:'Needs attention'},{id:'completed',label:'Completed'}] as const).map(option => <TutorialTarget key={option.id} name={option.id==='attention'?'attention':option.id==='completed'?'status':'all'}><PressableScale onPress={() => app.setProofsView(option.id)} accessibilityRole="tab" accessibilityState={{ selected:library.view === option.id }} style={[styles.tab, { backgroundColor: library.view === option.id ? colors.accentSoft : 'transparent' }]}><Text style={[styles.tabText,{color:library.view === option.id ? colors.accentText : colors.textSecondary}]}>{option.label}</Text></PressableScale></TutorialTarget>)}
    </ScrollView>
    <View style={styles.searchRow}>
      <View style={[styles.search,{borderColor:colors.controlBorder,backgroundColor:colors.inputBackground}]}><Ionicons name="search-outline" size={18} color={colors.textSecondary}/><TextInput value={library.query} onChangeText={app.setProofsQuery} placeholder="Search order, item, tracking…" placeholderTextColor={colors.textSecondary} accessibilityLabel="Search Proofs" autoCapitalize="none" autoCorrect={false} style={[styles.input,{color:colors.textPrimary}]}/></View>
      <PressableScale onPress={() => setFilterOpen(true)} accessibilityRole="button" accessibilityLabel="Filters" style={[styles.filter,{borderColor:colors.controlBorder}]}><Ionicons name="options-outline" size={22} color={colors.textPrimary}/></PressableScale>
    </View>
    </View>
    {!MOBILE_TASK_UX_ENABLED ? <View style={[styles.tableHeading,{backgroundColor:colors.surfaceElevated,borderColor:colors.border}]}><Text style={[styles.columnLabel,{color:colors.textMuted}]}>SHIPMENT RECORDS</Text><Text style={[styles.columnLabel,{color:colors.textMuted}]}>{loading ? 'LOADING' : `${visibleCount} IN VIEW`}</Text></View> : null}
    <View style={styles.listBody}>
    <OfflineBanner visible={app.offline} />
    <ErrorBanner message={app.error || (app.offline && !snapshot.rows.length ? "Proofs could not be loaded while offline. Reconnect and try again." : null)}/>
    {app.error || (app.offline && !snapshot.rows.length) ? <Button label="Try loading Proofs again" variant="tertiary" onPress={() => void refresh()} /> : null}
    {showPrepared ? <ReadyOrders onPreparedProofsChange={setPreparedProofIds} /> : null}
    {changed && !loading ? <Button label="Updates available · Refresh" variant="tertiary" onPress={() => setRequestedRefresh(true)} /> : null}
    {loading && !rows.length && !app.error ? <><ProofCardSkeleton/><ProofCardSkeleton/></> : null}
    {libraryRows.map((item, index) => {
      return <TutorialTarget key={item.proofId} name={index===0?"proofs":""}><FadeSlideIn index={index}>
        <View style={[styles.row,{backgroundColor:colors.surface,borderColor:colors.border}]}>
          <LiftPressable onPress={() => void open(item)} accessibilityRole="button" accessibilityLabel={`${item.transaction.itemTitle || 'Shipment Proof'}. ${item.presentation.displayStatus}. Open Proof`} style={styles.rowCopy}>
            <View style={styles.recordHeading}>{item.thumbnailDerivativeId ? <RecordThumbnail key={`${app.session?.userId}:${item.proofId}:${item.thumbnailDerivativeId}`} proofId={item.proofId} derivativeId={item.thumbnailDerivativeId} /> : null}<View style={{flex:1,gap:5}}>
            <Text style={[styles.rowTitle,{color:colors.textPrimary}]}>{item.transaction.itemTitle || 'Shipment Proof'}</Text>
            {!MOBILE_TASK_UX_ENABLED ? <Text style={[styles.meta,{color:colors.textSecondary}]}>{proofReference(item.proofId,item.transaction.externalReference)}</Text> : null}
            </View><Ionicons name="chevron-forward" size={18} color={colors.textSecondary}/></View>
            {!MOBILE_TASK_UX_ENABLED ? <><RecordSeal status={item.status}/><View style={styles.shipmentLine}><Ionicons name="navigate-outline" size={15} color={colors.textSecondary}/><Text style={[styles.meta,{color:colors.textSecondary,flexShrink:1}]}>Shipment: {shipmentRecordLabel(item.transaction.trackingNumber,item.presentation.shipmentStatus)}</Text></View></> : null}
            {MOBILE_TASK_UX_ENABLED || item.presentation.needsAttention ? <StatusBadge label={item.presentation.displayStatus}/> : null}
            {Object.prototype.hasOwnProperty.call(app.uploadProgressByProof, item.proofId) ? <View style={{ gap: 8 }}>
              <ProgressState label="Recording upload" showLabel={false} percent={app.uploadProgressByProof[item.proofId]} />
              {!MOBILE_TASK_UX_ENABLED ? <Text style={[typography.finePrint, { color: colors.textSecondary }]}>Upload continues while you work on the next Proof.</Text> : null}
            </View> : null}
            <Text style={[styles.meta,{color:colors.textSecondary}]}>{[item.transaction.provider, `Updated ${formatDate(item.updatedAt)}`].filter(Boolean).join(' · ')}</Text>
          </LiftPressable>
          {item.presentation.needsAttention ? <Button label={item.presentation.nextAction.label} variant="tertiary" onPress={() => void open(item,true)} loading={app.busy} /> : null}
        </View>
      </FadeSlideIn></TutorialTarget>;
    })}
    {!loading && !app.error && !app.offline && !visibleCount ? <TutorialTarget name="proofs"><EmptyState title={emptyTitle} body={noMatches ? 'Try another reference or clear your filters.' : library.view === 'attention' ? 'Waiting and uploading Proofs are still available in All.' : library.view === 'completed' ? 'Proofs appear here when their evidence is finalized. Delivery is tracked separately.' : 'Connected-store orders appear here automatically. Use New Proof for another shipment.'} actionLabel={noMatches ? 'Clear search and filters' : library.view !== 'all' ? 'View all Proofs' : undefined} onAction={noMatches ? () => { app.setProofsQuery('');app.setProofsRoleFilter('all');app.setProofsCarrierFilter(null); } : () => app.setProofsView('all')} /></TutorialTarget> : null}
    </View>
    </View>
    <BottomSheet visible={filterOpen} title="Filters" onClose={() => setFilterOpen(false)}>
      <Text style={[styles.rowTitle,{color:colors.textPrimary}]}>Your role</Text>
      {(['all','seller','buyer'] as const).map(role => <Button key={role} label={`${library.role === role ? '✓ ' : ''}${role === 'all' ? 'All roles' : role === 'seller' ? 'Seller' : 'Buyer'}`} variant="tertiary" onPress={() => app.setProofsRoleFilter(role)} />)}
      <Button label="Done" onPress={() => setFilterOpen(false)} />
    </BottomSheet>
  </AppScreen>;
}
const styles = StyleSheet.create({
  recordHeading:{flexDirection:'row',gap:12,alignItems:'center'},shipmentLine:{flexDirection:'row',gap:7,alignItems:'center'},
  heading:{flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:12},headingCopy:{gap:5},pageTitle:{...typography.pageTitle,fontSize:29,lineHeight:36},
  mobileTitle:{fontSize:24,lineHeight:31},
  eyebrow:{...typography.finePrint,fontFamily:'Inter-SemiBold',fontSize:10,lineHeight:15,letterSpacing:1.15},subtitle:{...typography.secondary,fontSize:14,marginTop:-8},
  libraryPanel:{borderWidth:1,borderRadius:10,overflow:'hidden'},toolbar:{padding:14,gap:12},
  tabs:{flexDirection:'row',gap:3},tab:{minHeight:48,paddingHorizontal:10,paddingVertical:10,borderRadius:6,justifyContent:'center'},tabText:{...typography.secondaryStrong,fontSize:13,lineHeight:19},
  searchRow:{flexDirection:'row',gap:8},search:{flex:1,minHeight:48,flexDirection:'row',alignItems:'center',paddingHorizontal:10,borderWidth:1,borderRadius:6,gap:8},input:{flex:1,...typography.secondary,fontSize:14,paddingVertical:8},filter:{minWidth:48,minHeight:48,alignItems:'center',justifyContent:'center',borderWidth:1,borderRadius:6},
  tableHeading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10,paddingHorizontal:16,paddingVertical:10,borderTopWidth:1,borderBottomWidth:1},columnLabel:{...typography.finePrint,fontSize:12,lineHeight:18,letterSpacing:.35},listBody:{gap:0},
  row:{padding:16,borderBottomWidth:1,gap:9},rowCopy:{gap:9,minHeight:48},rowTitle:{...typography.bodyStrong,fontSize:15,lineHeight:22},meta:{...typography.secondary,fontSize:12,lineHeight:18},status:{...typography.secondaryStrong},
});
