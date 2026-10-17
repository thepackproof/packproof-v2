import { EXPERIENCE_RESTORATION_REVIEW } from '../experience/restoration-review';
import { StateTransition } from '../ui/motion';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { proofDisplayTitle } from '../copy/proof-title';
import { useTaskHome } from '../experience/use-task-home';
import { TutorialTarget } from '../onboarding/Onboarding';
import { useTheme } from '../theme/ThemeProvider';
import { taskFirstTypography as type } from '../theme/tokens';
import { AppScreen } from '../ui/AppScreen';
import { Button } from '../ui/Button';
import { CompactProofRow } from '../ui/CompactProofRow';
import { ErrorBanner } from '../ui/EmptyState';
import { PressableScale } from '../ui/motion';
import { WorkspaceHeader } from '../ui/WorkspaceHeader';

/** Android composition over the existing authorized task and recovery selectors. */
export function AndroidTaskHomeScreen() {
  const app = usePackProof(), home = useTaskHome(), { colors } = useTheme();
  const action = home.recommendation;
  const creating = action.kind === 'create_proof';
  const proof = app.proofCollection.find(row => row.proofId === action.targetId);
  const title = creating ? (home.empty ? 'Create your first Proof' : 'Create a Proof')
    : proof ? proofDisplayTitle(proof) : action.title;
  const attention = home.attention.filter(row => row.proof.proofId !== action.targetId && (!EXPERIENCE_RESTORATION_REVIEW || !app.pendingInvites.some(i=>i.proofId===row.proof.proofId))).slice(0, 3);
  function showAttention() {
    app.setProofsView('attention'); app.setProofsQuery(''); app.setProofsRoleFilter('all');
    app.setProofsCarrierFilter(null); app.go('proofs');
  }
  return <AppScreen background={EXPERIENCE_RESTORATION_REVIEW ? colors.surface : undefined} padded={false} bottomInset={false} restorationReady={!home.loading}
    initialOffsetY={app.readWorkspaceOffset('home')} onScrollOffset={offset => app.setWorkspaceOffset('home', offset)}
    onRefresh={() => void home.refresh()} refreshing={home.refreshing}>
    <View style={styles.content}>
      <WorkspaceHeader section="Home" />
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={[type.pageTitle, { color: colors.textPrimary }]}>{EXPERIENCE_RESTORATION_REVIEW ? home.empty ? "Before it leaves your hands." : "Welcome back." : "Home"}</Text>
        <Text style={[type.body, { color: colors.textSecondary }]}>Your packing, clearly documented.</Text>
      </View>
      <StateTransition eventKey={[action.kind,action.targetId,action.sessionId].join(':')}><View style={[styles.focus, { backgroundColor: EXPERIENCE_RESTORATION_REVIEW ? colors.surface : colors.accentSoft, borderColor: colors.accentSoftBorder }, EXPERIENCE_RESTORATION_REVIEW ? {borderWidth:0,borderLeftWidth:3,borderLeftColor:colors.accent,borderRadius:0,paddingLeft:18} : null]}
        onTouchStart={() => home.setInteracting(true)} onTouchEnd={() => home.setInteracting(false)}
        onTouchCancel={() => home.setInteracting(false)}>
        {home.loading ? <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Loading your next action">
          <View style={[styles.placeholder, { backgroundColor: colors.surfaceElevated, width: '44%' }]} />
          <View style={[styles.placeholder, { backgroundColor: colors.surfaceElevated }]} />
          <View style={[styles.placeholderButton, { backgroundColor: colors.surfaceElevated }]} />
        </View> : <>
          <Text style={[styles.eyebrow, { color: colors.accentText }]}>{creating ? 'PACK IT. RECORD IT.' : EXPERIENCE_RESTORATION_REVIEW ? 'RECOMMENDED NEXT ACTION' : 'YOUR NEXT STEP'}</Text>
          <Text accessibilityRole="header" style={[styles.focusTitle, { color: colors.textPrimary }]}>{title}</Text>
          <TutorialTarget name="capture"><PressableScale accessibilityRole="button" accessibilityLabel={action.buttonLabel}
            accessibilityState={{ disabled: app.busy, busy: app.busy }} disabled={app.busy}
            onFocus={() => home.setInteracting(true)} onBlur={() => home.setInteracting(false)}
            onPressIn={() => home.setInteracting(true)} onPressOut={() => home.setInteracting(false)}
            onPress={() => void home.runAction(action)}
            style={[styles.primary, { backgroundColor: app.busy ? colors.disabledBackground : colors.primary }]}>
            {app.busy ? <ActivityIndicator color={colors.disabledText} /> : null}<Text style={[type.button, { color: app.busy ? colors.disabledText : colors.textOnPrimary, textAlign: 'center', flexShrink: 1, minWidth: 0 }]}>{action.buttonLabel}</Text>
          </PressableScale></TutorialTarget>
          <Text style={[type.secondary, { color: colors.textSecondary }]}>{creating
            ? 'Keep a clear record of how you packed your item.' : action.reason}</Text>
        </>}
      </View></StateTransition>
      {home.loading || !creating ? <TutorialTarget name="create"><Button label="Create a new Proof" icon="add-outline"
        variant="secondary" disabled={app.busy} onPress={() => app.selectCreateProof()} /></TutorialTarget>
        : <Button label="See capture options" variant="tertiary" onPress={() => app.go('station')} />}
      {app.offline ? <View style={[styles.notice, { backgroundColor: colors.warningSoft }]}>
        <Text accessibilityLiveRegion="polite" style={[type.secondary, { color: colors.warningText }]}>You’re offline. Saved recordings stay on this device. Connect before creating a Proof.</Text>
      </View> : null}
      {(!app.workspaceReconciled || app.offline) && home.freshnessLabel ? <Text accessibilityLiveRegion="polite"
        style={[type.secondary, { color: colors.textSecondary }]}>{home.freshnessLabel}</Text> : null}
      <ErrorBanner message={home.error} />
      {home.error ? <Button label="Refresh your records" variant="tertiary" onPress={() => void home.refresh()} /> : null}
      {home.counts.waiting > 0 || home.counts.uploading > 0 ? <Button
        label={home.counts.uploading > 0 ? `${home.counts.uploading} ${home.counts.uploading === 1 ? 'upload' : 'uploads'} in progress`
          : `${home.counts.waiting} ${home.counts.waiting === 1 ? 'upload' : 'uploads'} waiting${app.offline ? ' for connection' : ''}`}
        variant="tertiary" onPress={() => app.go('activity', { activityFilter: 'uploading' })} /> : null}
      {EXPERIENCE_RESTORATION_REVIEW && app.pendingInvites.length ? <View style={{gap:8,borderTopWidth:1,borderTopColor:colors.divider,paddingTop:18}}>
        <Text accessibilityRole="header" style={[type.rowTitle,{color:colors.textPrimary}]}>Incoming tasks · {app.pendingInvites.length}</Text>
        {app.pendingInvites.map(invite=><CompactProofRow key={invite.invitationId} title={app.proofCollection.find(p=>p.proofId===invite.proofId)?.transaction.itemTitle || 'Incoming Proof invitation'} detail="Review the invitation before accepting the requested work." disabled={app.busy} onPress={()=>app.openInvitation(invite)} />)}
      </View> : null}
      {attention.length ? <TutorialTarget name="attention"><View>
        <View style={styles.sectionHeading}><Text accessibilityRole="header" style={[type.rowTitle, styles.sectionTitle, { color: colors.textPrimary }]}>Also needs your attention</Text>
          <Button label="View all" variant="tertiary" onPress={showAttention} /></View>
        {attention.map(({ proof: row, action: next }) => <CompactProofRow key={row.proofId}
          title={proofDisplayTitle(row)} detail={next.reason} disabled={app.busy} onPress={() => void home.runAction(next)} />)}
      </View></TutorialTarget> : home.empty && !home.loading ? <Text style={[type.secondary, { color: colors.textSecondary }]}>No selling account connection needed. Start with an item and one continuous packing video.</Text> : null}
    </View>
  </AppScreen>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 8, gap: 12 }, heading: { gap: 4, marginBottom: 2 },
  focus: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 7 },
  eyebrow: { ...type.rowTitle, fontSize: 11, lineHeight: 16, letterSpacing: 1 },
  focusTitle: { ...type.sectionTitle, fontSize: 19, lineHeight: 25 },
  primary: { gap: 8, flexDirection: 'row', minHeight: 48, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 12, justifyContent: 'center', alignItems: 'center', marginTop: 3 },
  notice: { padding: 12, borderRadius: 9 }, sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  sectionTitle: { flex: 1, minWidth: 130 }, loading: { gap: 12 },
  placeholder: { height: 20, borderRadius: 5 }, placeholderButton: { height: 48, borderRadius: 8 },
});
