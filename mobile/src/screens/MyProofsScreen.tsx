import { ReadyOrders } from "../intake/ReadyOrders";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { localProofWork, mergeProofInvitations, presentationForProof, selectProofRows, type PresentedProof } from '../copy/proof-list';
import { formatDate } from '../copy/format';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppScreen } from '../ui/AppScreen';
import { AvatarButton } from '../ui/AvatarButton';
import { BottomSheet } from '../ui/Sheets';
import { EmptyState, ErrorBanner, OfflineBanner } from '../ui/EmptyState';
import { ProofCardSkeleton } from '../ui/Skeleton';
import { Button } from '../ui/Button';
import { PressableScale } from '../ui/motion';
import type { ProofCollectionItem, InvitationInboxView } from '../v2-api';

export function MyProofsScreen() {
  const app = usePackProof();
  const { colors, scheme } = useTheme();
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
  const presentedRows = useMemo(() => mergeProofInvitations(snapshot.rows, snapshot.invites).map(item => {
    const capture = app.savedRecordings.find(row => row.captureProofId === item.proofId && row.recovery?.phase !== 'FINALIZED')
      ?? (app.session?.captureProofId === item.proofId ? app.localCapture : null);
    return { ...item, presentation:presentationForProof(item, item.role, localProofWork(capture, app.session?.captureProofId === item.proofId ? app.captureStatus : undefined, app.session?.captureProofId === item.proofId ? app.uploadPercent : undefined)) };
  }), [snapshot, library, app.savedRecordings, app.localCapture, app.captureStatus, app.uploadPercent]);
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
      <Image source={scheme === 'dark' ? require('../../assets/packproof-wordmark-reversed.png') : require('../../assets/packproof-wordmark.png')} style={styles.wordmark} resizeMode="contain" accessibilityLabel="PackProof" />
      <AvatarButton displayName={app.session?.displayName} username={app.session?.username} onPress={() => app.go('account')} />
    </View>
    <View style={styles.heading}><Text style={[styles.pageTitle, { color:colors.textPrimary }]}>Proofs</Text><Button label="New Proof" icon="add-outline" onPress={() => app.go('create')} /></View>
    <View style={[styles.tabs, { borderBottomColor:colors.divider }]} accessibilityRole="tablist" accessibilityLabel="Filter Proofs">
      {([{id:'all',label:'All'},{id:'attention',label:'Needs attention'},{id:'completed',label:'Completed'}] as const).map(option => <PressableScale key={option.id} onPress={() => app.setProofsView(option.id)} accessibilityRole="tab" accessibilityState={{ selected:library.view === option.id }} style={[styles.tab, { borderBottomColor:library.view === option.id ? colors.accent : 'transparent' }]}><Text style={[styles.tabText,{color:library.view === option.id ? colors.accentText : colors.textSecondary}]}>{option.label}</Text></PressableScale>)}
    </View>
    <View style={styles.searchRow}>
      <View style={[styles.search,{borderColor:scheme === "dark" ? "#8B9790" : "#7B8580",backgroundColor:colors.surface}]}><Ionicons name="search-outline" size={20} color={colors.textSecondary}/><TextInput value={library.query} onChangeText={app.setProofsQuery} placeholder="Search Proofs" placeholderTextColor={colors.textSecondary} accessibilityLabel="Search Proofs" autoCapitalize="none" autoCorrect={false} style={[styles.input,{color:colors.textPrimary}]}/></View>
      <PressableScale onPress={() => setFilterOpen(true)} accessibilityRole="button" accessibilityLabel="Filters" style={[styles.filter,{borderColor:scheme === "dark" ? "#8B9790" : "#7B8580"}]}><Ionicons name="options-outline" size={22} color={colors.textPrimary}/></PressableScale>
    </View>
    <OfflineBanner visible={app.offline} />
    <ErrorBanner message={app.error || (app.offline && !snapshot.rows.length ? "Proofs could not be loaded while offline. Reconnect and try again." : null)}/>
    {app.error || (app.offline && !snapshot.rows.length) ? <Button label="Try loading Proofs again" variant="tertiary" onPress={() => void refresh()} /> : null}
    {library.view !== "completed" && !library.query.trim() ? <ReadyOrders onPreparedProofsChange={setPreparedProofIds} /> : null}
    {changed && !loading ? <Button label="Updates available · Refresh" variant="tertiary" onPress={() => setRequestedRefresh(true)} /> : null}
    {loading && !rows.length && !app.error ? <><ProofCardSkeleton/><ProofCardSkeleton/></> : null}
    {rows.filter(item => !preparedProofIds.includes(item.proofId)).map(item => <View key={item.proofId} style={[styles.row,{backgroundColor:colors.surface,borderBottomColor:colors.divider}]}>
      <PressableScale onPress={() => void open(item)} accessibilityRole="button" accessibilityLabel={`${item.transaction.itemTitle || 'Shipment Proof'}. ${item.presentation.displayStatus}. Open Proof`} style={styles.rowCopy}>
        <Text style={[styles.rowTitle,{color:colors.textPrimary}]}>{item.transaction.itemTitle || 'Shipment Proof'}</Text>
        <Text style={[styles.meta,{color:colors.textSecondary}]}>{item.transaction.externalReference ? `Order ${item.transaction.externalReference}` : `Proof ${item.proofId.slice(0,8)}`}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.status,{color:item.presentation.completed ? colors.successText : colors.textPrimary}]}>{item.presentation.displayStatus}</Text>
        <Text style={[styles.meta,{color:colors.textSecondary}]}>{[item.transaction.provider, `Updated ${formatDate(item.updatedAt)}`].filter(Boolean).join(' · ')}</Text>
      </PressableScale>
      <Button label={item.presentation.nextAction.label} variant="tertiary" onPress={() => void open(item,true)} loading={app.busy} />
    </View>)}
    {!loading && !app.error && !app.offline && !rows.length && !preparedProofIds.length ? <EmptyState title={emptyTitle} body={noMatches ? 'Try another reference or clear your filters.' : library.view === 'attention' ? 'Waiting and uploading Proofs are still available in All.' : library.view === 'completed' ? 'Proofs appear here when their evidence is finalized. Delivery is tracked separately.' : 'Connected-store orders appear here automatically. Use New Proof for another shipment.'} actionLabel={noMatches ? 'Clear search and filters' : library.view !== 'all' ? 'View all Proofs' : undefined} onAction={noMatches ? () => { app.setProofsQuery('');app.setProofsRoleFilter('all');app.setProofsCarrierFilter(null); } : () => app.setProofsView('all')} /> : null}
    <BottomSheet visible={filterOpen} title="Filters" onClose={() => setFilterOpen(false)}>
      <Text style={[styles.rowTitle,{color:colors.textPrimary}]}>Your role</Text>
      {(['all','seller','buyer'] as const).map(role => <Button key={role} label={`${library.role === role ? '✓ ' : ''}${role === 'all' ? 'All roles' : role === 'seller' ? 'Seller' : 'Buyer'}`} variant="tertiary" onPress={() => app.setProofsRoleFilter(role)} />)}
      <Button label="Done" onPress={() => setFilterOpen(false)} />
    </BottomSheet>
  </AppScreen>;
}
const styles = StyleSheet.create({
  topBar:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:16},wordmark:{width:170,height:40},
  heading:{flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:12},pageTitle:{...typography.pageTitle},
  tabs:{flexDirection:'row',flexWrap:'wrap',borderBottomWidth:1,gap:8},tab:{minHeight:48,paddingHorizontal:8,paddingVertical:12,borderBottomWidth:2,justifyContent:'center'},tabText:{...typography.secondaryStrong},
  searchRow:{flexDirection:'row',gap:8},search:{flex:1,minHeight:48,flexDirection:'row',alignItems:'center',paddingHorizontal:12,borderWidth:1,borderRadius:6,gap:8},input:{flex:1,...typography.body,paddingVertical:8},filter:{minWidth:48,minHeight:48,alignItems:'center',justifyContent:'center',borderWidth:1,borderRadius:6},
  row:{padding:16,borderBottomWidth:1,gap:8},rowCopy:{gap:6,minHeight:48},rowTitle:{...typography.bodyStrong},meta:{...typography.secondary},status:{...typography.secondaryStrong},
});
