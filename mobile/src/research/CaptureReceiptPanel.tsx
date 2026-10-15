import { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { committedRecordEvidence, type RecordEvidence } from '../copy/proof-record';
import { Button } from '../ui/Button';
import { ProofEvidencePreview } from '../ui/ProofEvidencePreview';
import { ReceiptConsent } from './ReceiptConsent';
import { checkedReceiptReview, type ReceiptReview } from './receipt-review';

export function CaptureReceiptPanel() {
  const app = usePackProof(), { colors } = useTheme();
  const proofId = app.proof!.proofId, userId = app.session!.userId, apiBase = app.client.apiBaseUrl;
  const [review, setReview] = useState<ReceiptReview | null>(null), [source, setSource] = useState<RecordEvidence | null>(null);
  const [busy, setBusy] = useState(false), [canExport, setCanExport] = useState(false), [error, setError] = useState<string | null>(null);
  const alive = useRef(false), operation = useRef(false);
  function assertScope() { app.client.assertCaptureAccount(userId, apiBase); if (!alive.current) throw new Error('This Proof is no longer open.'); }
  async function refresh() {
    const data = checkedReceiptReview(await app.client.researchRequest<ReceiptReview>(proofId, '/capture-receipts'), proofId);
    assertScope(); setReview(data);
    const policy = await app.client.researchCapabilities().catch(() => null);
    assertScope(); setCanExport(policy?.profile === 'capture-receipts-v1' && policy.supportedOperations?.receiptExport === true && policy.supportedOperations.receiptExportMode === 'METADATA_ONLY');
  }
  async function run(action: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setBusy(true); setError(null);
    try { await app.ensureAuth(); assertScope(); await action(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Capture receipt unavailable.'); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void run(refresh); return () => { alive.current = false; }; }, []);
  async function exportBundle() {
    if (!FileSystem.cacheDirectory || !await Sharing.isAvailableAsync()) throw new Error('Sharing is unavailable on this device.');
    assertScope();
    const file = `${FileSystem.cacheDirectory}packproof-capture-receipts-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`;
    try {
      const result = await FileSystem.downloadAsync(app.client.researchContentUrl(proofId, '/export.zip'), file, { headers: app.client.authorizedDownloadHeaders() });
      assertScope();
      if (result.status !== 200) throw new Error('The capture receipt archive is unavailable.');
      await Sharing.shareAsync(file, { mimeType: 'application/zip', dialogTitle: 'Export signed capture receipt metadata' });
    } finally { await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined); }
  }
  function openSource(evidenceId: string, hash: string) {
    const evidence = committedRecordEvidence(app.proof!).find(row => row.evidenceId === evidenceId && row.sha256 === hash);
    if (!evidence) { setError('The receipt source is not in the current authorized record. Refresh the Proof to check it.'); return; }
    setSource(evidence);
  }
  const muted = { color: colors.textSecondary };
  return <View style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 16 }}>
    <ReceiptConsent />
    <Text style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '600' }}>Capture receipts</Text>
    <Text style={muted}>These optional signed records describe the final file and its server-recorded camera session. They do not verify the sensor, physical scene, item authenticity or incremental recording continuity. The original recording remains your evidence.</Text>
    {review?.captureReceipts.length === 0 ? <Text style={muted}>No optional capture receipt has been received for this Proof. Ordinary saved evidence remains available in the Evidence tab.</Text> : null}
    {review?.captureReceipts.map(row => <View key={row.receipt.intentId} style={{ gap: 6 }}>
      <Text style={{ color: colors.textPrimary }}>Final-file receipt received · {row.receipt.receivedAt}</Text>
      <Text style={muted}>Coverage: final file only. Server reports {row.receipt.assurance.signatureVerification === 'BOUND_CLIENT_AND_SERVER_SIGNATURES' ? 'bound device and server signatures' : 'a server signature'}. Signature trust is independently checked with the exported bundle.</Text>
      {row.receipt.sources.map(item => <View key={item.evidenceId} style={{ gap: 4 }}><Text selectable style={muted}>Original SHA-256: {item.sha256} · {item.byteLength} bytes</Text><Button label="Open associated original recording" variant="tertiary" onPress={() => openSource(item.evidenceId, item.sha256)} /></View>)}
    </View>)}
    <Button label="Refresh capture receipts" variant="secondary" disabled={busy} onPress={() => void run(refresh)} />
    {canExport && !!review?.captureReceipts.length ? <><Button label="Export signed receipt metadata" variant="secondary" disabled={busy} onPress={() => void run(exportBundle)} /><Text style={muted}>The archive contains signed metadata and source hashes. It does not contain the original video; use its ordinary download control separately.</Text></> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text> : null}
    <Modal visible={source !== null} onRequestClose={() => setSource(null)} animationType="slide"><ScrollView contentContainerStyle={{ padding: 20, gap: 16, backgroundColor: colors.background }}><Button label="Close original recording" onPress={() => setSource(null)} />{source ? <ProofEvidencePreview evidence={source} title="Preserved original recording" bookmarks={[]} /> : null}</ScrollView></Modal>
  </View>;
}
