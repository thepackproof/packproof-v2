import { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { toByteArray } from 'base64-js';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from '../ui/Button';
import { newIdempotencyKey } from '../v2-api';
import { SIDECAR_PREVIEW_MAX_BYTES, verifySidecarOriginal, verifySidecarPreview, type SidecarPreviewSource } from './sidecar-preview-policy';

export function ResearchSidecarPreview({ proofId, source }: { proofId: string; source: SidecarPreviewSource }) {
  const app = usePackProof(), { colors } = useTheme();
  const [uri, setUri] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), inFlight = useRef(false);
  const files = useRef<string[]>([]);
  const removeFiles = async () => { await Promise.all(files.current.map(file => FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined))); };
  useEffect(() => { alive.current = true; void preview(); return () => { alive.current = false; void removeFiles(); }; }, []);
  async function readBounded(file: string): Promise<Uint8Array> {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists || info.isDirectory || !('size' in info) || info.size < 1 || info.size > SIDECAR_PREVIEW_MAX_BYTES) throw new Error('Native sidecar exceeds the bounded display size');
    return toByteArray(await FileSystem.readAsStringAsync(file, { encoding: FileSystem.EncodingType.Base64 }));
  }
  async function preview() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setUri(null);
    try {
      if (!FileSystem.cacheDirectory) throw new Error('Preview storage unavailable');
      await app.ensureAuth();
      if (!alive.current) return;
      await removeFiles();
      const prefix = `${FileSystem.cacheDirectory}rnd-sidecar-${newIdempotencyKey()}`;
      const original = `${prefix}.pgm`, display = `${prefix}.png`; files.current = [original, display];
      const path = `/sidecars/${source.id}`;
      const rawResponse = await FileSystem.downloadAsync(app.client.researchContentUrl(proofId, path), original, { headers: app.client.authorizedDownloadHeaders() });
      if (rawResponse.status !== 200) throw new Error('Original native sidecar unavailable');
      verifySidecarOriginal(await readBounded(original), source);
      if (!alive.current) return;
      const response = await FileSystem.downloadAsync(app.client.researchContentUrl(proofId, `${path}/preview`), display, { headers: app.client.authorizedDownloadHeaders() });
      if (response.status !== 200) throw new Error('Native sidecar display unavailable');
      verifySidecarPreview(response.headers, await readBounded(display), source);
      if (alive.current) setUri(display);
    } catch (cause) {
      await removeFiles();
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Native sidecar preview unavailable');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false); else await removeFiles();
    }
  }
  return <View style={{ gap: 10 }}>
    <Text style={{ color: colors.textPrimary }}>Native luma sidecar</Text>
    <Text style={{ color: colors.textSecondary }}>The original PGM file is checked against the observation’s byte length and SHA-256. This image is a server-generated PNG display conversion with no resizing. It is a concurrent sidecar; pixel equivalence to the original recording is not asserted.</Text>
    <Text selectable style={{ color: colors.textSecondary }}>Original SHA-256: {source.sha256}</Text>
    {uri ? <Image source={{ uri }} style={{ width: '100%', height: 300 }} resizeMode="contain" accessibilityLabel="Display conversion of the verified native luma sidecar" onError={() => { setUri(null); setError('This device could not display the native sidecar image.'); }} /> : null}
    {!uri ? <Button label={busy ? 'Checking native sidecar…' : 'Retry native sidecar preview'} disabled={busy} variant="secondary" onPress={() => void preview()} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text> : null}
  </View>;
}
