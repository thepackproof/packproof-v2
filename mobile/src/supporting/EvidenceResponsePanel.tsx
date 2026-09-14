import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';
import { AppState, Text, TextInput, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { newIdempotencyKey } from '../v2-api';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/EmptyState';
import { InfoCard } from '../ui/ProofCard';
import { StatementController, statementFacts, type StatementState } from './statements';

type Props = { proofId: string; userId: string; role: string };
const emptyState: StatementState = { loaded: false, intent: null, records: [], busy: false, saving: false, storageBlocked: false, error: null, notice: null };

/** Changing account, API, Proof, or participant role creates an isolated screen state. */
export function EvidenceResponsePanel(props: Props) {
  const app = usePackProof();
  if (app.session?.userId !== props.userId || app.proof?.proofId !== props.proofId) return null;
  return <ScopedStatements key={JSON.stringify([app.client.apiBaseUrl, props.userId, props.proofId, props.role])} {...props} />;
}

function ScopedStatements({ proofId, userId, role }: Props) {
  const app = usePackProof(), { colors } = useTheme();
  const latest = useRef(app); latest.current = app;
  const controller = useRef<StatementController | null>(null);
  const [state, setState] = useState<StatementState>(emptyState);
  const client = app.client, scope = client.apiBaseUrl;
  useEffect(() => {
    let mounted = true;
    const assertActive = () => {
      if (!mounted || latest.current.session?.userId !== userId || latest.current.proof?.proofId !== proofId || latest.current.client !== client)
        throw new Error('Open the original account and Proof to continue this statement.');
      client.assertCaptureAccount(userId, scope);
    };
    const model = new StatementController({
      context: { scope, userId, proofId }, role, storage: AsyncStorage, operationId: newIdempotencyKey,
      assertActive,
      beforeRequest: async () => {
        assertActive();
        if (AppState.currentState !== 'active') throw new Error('Return to PackProof to continue. Your saved statement is kept.');
        await latest.current.ensureAuth(); assertActive();
        if (AppState.currentState !== 'active') throw new Error('Return to PackProof to continue. Your saved statement is kept.');
      },
      list: () => client.featureRequest(proofId, 'supplements'),
      post: body => client.featureRequest(proofId, 'supplements', 'POST', body),
      changed: value => { if (mounted) setState(value); },
    });
    controller.current = model; setState(model.snapshot());
    void model.load().catch(() => undefined);
    const wake = AppState.addEventListener('change', next => { if (next === 'active') void model.refresh(); });
    return () => { mounted = false; model.dispose(); wake.remove(); if (controller.current === model) controller.current = null; };
  }, [client, scope, userId, proofId, role]);

  const secondary = [typography.secondary, { color: colors.textSecondary }];
  const body = [typography.body, { color: colors.textPrimary }];
  const submitting = state.intent?.phase === 'SUBMITTING';
  const finalized = app.proof?.proofId === proofId && app.proof.status === 'FINALIZED';
  const participant = role === 'SELLER' || role === 'BUYER';
  const invoke = (operation: () => Promise<void>) => { void operation().catch(() => undefined); };
  return <View style={{ gap: 16 }}>
    <Text style={secondary}>Add context without changing the original packing record. Each response or correction is added as a separate participant statement.</Text>
    <ErrorBanner message={state.error} />
    {state.notice ? <Text accessibilityLiveRegion="polite" style={body}>{state.notice}</Text> : null}
    {!state.loaded ? <Text accessibilityLiveRegion="polite" style={secondary}>Loading your saved statement…</Text> : null}
    {state.records.map(record => {
      const facts = statementFacts(record);
      const title = record.kind === 'RECIPIENT_RESPONSE' ? 'Recipient response' : record.kind === 'CORRECTION' ? 'Correction' : 'Record update';
      return <InfoCard key={record.supplementId}>
        <Text style={[typography.secondaryStrong, { color: colors.textPrimary }]}>{title} · {record.sequence}</Text>
        <Text style={secondary}>{new Date(record.createdAt).toLocaleString()}</Text>
        <Text selectable style={body}>{typeof facts.statement === 'string' ? facts.statement : 'Source facts are available in the integrity record.'}</Text>
      </InfoCard>;
    })}
    <Button label="Refresh statements" variant="tertiary" disabled={state.busy || !state.loaded} onPress={() => invoke(() => controller.current?.refresh() ?? Promise.resolve())} />
    {!finalized ? <Text style={secondary}>The packing record needs to be sealed before a statement can be added. You can save your draft here.</Text> : null}
    {submitting ? <Text accessibilityLiveRegion="polite" style={secondary}>This saved statement is awaiting confirmation. Retrying sends the same request; it does not create a second response.</Text> : null}
    <View style={{ gap: 8 }}>
      <Text style={[typography.secondaryStrong, { color: colors.textPrimary }]}>{role === 'BUYER' ? 'Your response' : 'Your correction or additional context'}</Text>
      <TextInput
        accessibilityLabel={role === 'BUYER' ? 'Your response' : 'Your correction or additional context'}
        accessibilityHint={submitting ? 'This statement is locked while confirmation is pending.' : 'Your draft is saved on this device.'}
        value={state.intent?.text ?? ''} multiline maxLength={4000} textAlignVertical="top"
        editable={participant && state.loaded && !submitting && !state.busy && !(state.storageBlocked && !state.intent)}
        onChangeText={text => invoke(() => controller.current?.edit(text) ?? Promise.resolve())}
        placeholder="Add the details you want included with this Proof."
        placeholderTextColor={colors.textMuted}
        style={[typography.body, { minHeight: 150, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, color: colors.textPrimary, backgroundColor: colors.surface }]}
      />
      <Text accessibilityLiveRegion="polite" style={secondary}>{state.saving ? 'Saving draft…' : state.intent && !state.storageBlocked ? submitting ? 'Saved for retry on this device.' : 'Draft saved on this device.' : `${state.intent?.text.length ?? 0} / 4,000 characters`}</Text>
    </View>
    {state.storageBlocked && state.intent && !submitting ? <Button label="Save draft again" variant="secondary" disabled={state.busy || state.saving} onPress={() => invoke(() => controller.current?.edit(state.intent!.text) ?? Promise.resolve())} /> : null}
    {state.storageBlocked && !state.intent ? <Button label="Reload saved statement" variant="secondary" disabled={state.busy} onPress={() => invoke(() => controller.current?.load() ?? Promise.resolve())} /> : null}
    <Button label={state.busy ? 'Recording statement…' : submitting ? 'Retry saved statement' : 'Add statement to Proof'} variant="secondary"
      loading={state.busy} disabled={!participant || !finalized || !state.loaded || state.storageBlocked || state.saving || !state.intent?.text.trim()}
      onPress={() => invoke(() => controller.current?.submit() ?? Promise.resolve())} />
  </View>;
}
