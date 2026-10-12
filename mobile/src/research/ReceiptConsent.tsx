import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from '../ui/Button';
import { newIdempotencyKey } from '../v2-api';
import { productionReceiptsAvailable, receiptConsentGranted, RECEIPT_CONSENT_VERSION, type ReceiptConsents } from './production-policy';

/** Mount with the complete account/API/Proof key; preferences are never inferred from a local toggle. */
export function ReceiptConsent({ onBusy }: { onBusy?: (busy: boolean) => void }) {
  const app = usePackProof(), { colors } = useTheme();
  const proofId = app.proof!.proofId, userId = app.session!.userId, apiBaseUrl = app.client.apiBaseUrl;
  const [granted, setGranted] = useState<boolean | null>(null), [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null);
  const alive = useRef(false), operation = useRef(false);
  function assertScope() { app.client.assertCaptureAccount(userId, apiBaseUrl); if (!alive.current) throw new Error('This Proof is no longer open.'); }
  async function refresh() {
    assertScope();
    // Consent remains readable and withdrawable when collection is disabled.
    const consent = await app.client.researchRequest<ReceiptConsents>(proofId, '/consents');
    assertScope(); setGranted(receiptConsentGranted(consent, proofId));
    const policy = await app.client.researchCapabilities().catch(() => null);
    assertScope(); setAvailable(!!policy && productionReceiptsAvailable(policy) && consent.allowedPurposes.includes('EXPERIMENTAL_ANALYSIS'));
  }
  async function run(change?: boolean) {
    if (operation.current) return;
    operation.current = true; setBusy(true); onBusy?.(true); setError(null);
    try {
      await app.ensureAuth(); assertScope();
      if (change !== undefined) await app.client.researchRequest(proofId, '/consents', 'POST',
        { purpose: 'EXPERIMENTAL_ANALYSIS', version: RECEIPT_CONSENT_VERSION, granted: change }, newIdempotencyKey());
      await refresh();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Capture receipt preference unavailable.'); }
    finally { operation.current = false; if (alive.current) { setBusy(false); onBusy?.(false); } }
  }
  useEffect(() => { alive.current = true; void run(); return () => { alive.current = false; }; }, []);
  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Optional capture receipt</Text>
    <Text style={{ color: colors.textSecondary }}>For this Proof, attach signed details linking a new recording’s final file to its camera session. No additional frames, active camera tests or model training are collected by this option. It does not establish what happened in the scene or uninterrupted recording.</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>{granted === null ? (busy ? 'Checking your saved preference…' : 'Your saved preference could not be checked. Ordinary recording remains available.') : granted ? 'Your saved preference: on. Each new take also needs current service availability.' : 'Your saved preference: off. Ordinary recording works without this option.'}</Text>
    {!available && !busy ? <Text style={{ color: colors.textSecondary }}>New optional receipts are currently unavailable. You can still record and withdraw an existing preference.</Text> : null}
    {granted === false && available ? <Button label="Enable for this Proof" variant="secondary" disabled={busy} onPress={() => void run(true)} /> : null}
    {granted === true ? <Button label="Turn off future capture receipts" variant="tertiary" disabled={busy} onPress={() => void run(false)} /> : null}
    <Text style={{ color: colors.textSecondary }}>Turning this off stops future optional collection. Existing evidence and issued receipts are preserved.</Text>
    {error ? <><Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text><Button label="Check receipt preference again" variant="tertiary" disabled={busy} onPress={() => void run()} /></> : null}
  </View>;
}
