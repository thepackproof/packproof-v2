import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Image, Platform, StyleSheet, Switch, Text, View, type GestureResponderEvent } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { usePackProof } from '../app/PackProofProvider';
import type { ProofView } from '../v2-api';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { MAX_MASKS, MAX_SOURCE_BYTES, approvalBody, buildMasks, defaultMask, fitMediaFrame, maskFromDrag, mediaKind, readCopies, redactionStatus, type Dimensions, type MaskDraft, type RedactionCopy, type RedactionMask } from './redactions';

type PreviewSource = { uri: string; headers: Record<string, string>; kind: 'image' | 'video'; key: string };

/** Remount the whole editor when account, API, or Proof changes. */
export function MediaPrivacyTools({ proof }: { proof: ProofView }) {
  const app = usePackProof();
  const scope = `${app.client.apiBaseUrl}|${app.session?.userId ?? ''}|${proof.proofId}`;
  const current = useRef(scope); current.current = scope;
  return <ScopedMediaPrivacyTools key={scope} proof={proof} stillCurrent={() => current.current === scope} />;
}

function ScopedMediaPrivacyTools({ proof, stillCurrent }: { proof: ProofView; stillCurrent: () => boolean }) {
  const app = usePackProof(), { colors } = useTheme();
  const client = app.client;
  const mounted = useRef(true), lock = useRef(false), previewRevision = useRef(0);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [copies, setCopies] = useState<RedactionCopy[]>([]);
  const [sourceId, setSourceId] = useState(''), [source, setSource] = useState<PreviewSource | null>(null);
  const [masks, setMasks] = useState<MaskDraft[]>([]), [sourceLoaded, setSourceLoaded] = useState(false);
  const [review, setReview] = useState<{ copy: RedactionCopy; source: PreviewSource } | null>(null);
  const [loadedHash, setLoadedHash] = useState<string | null>(null), [confirmed, setConfirmed] = useState(false);
  const eligible = proof.evidence.filter(item => item.validationStatus === 'COMMITTED' && mediaKind(item.contentType));
  const evidenceIds = new Set(proof.evidence.filter(item => item.validationStatus === 'COMMITTED').map(item => item.evidenceId));
  const canManage = proof.participants.some(item => item.userId === app.session?.userId && item.role === 'SELLER' && item.status === 'JOINED');
  const disabled = busy || app.offline || !canManage;
  const selected = eligible.find(item => item.evidenceId === sourceId);
  const copy = (value: string) => <Text style={[styles.copy, { color: colors.textSecondary }]}>{value}</Text>;
  const isCurrent = () => mounted.current && stillCurrent();
  const assertCurrent = () => { if (!isCurrent()) throw new Error('Reopen private copies from the current Proof and account.'); };
  const assertAuthorizedScope = () => {
    assertCurrent();
    // The client's account reader uses the provider's live refs, also fencing
    // account changes that occur before React has rendered a new scope key.
    client.assertCaptureAccount(app.session?.userId ?? '', client.apiBaseUrl);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function auth() { assertCurrent(); await app.ensureAuth(); assertAuthorizedScope(); }
  async function refresh() {
    assertAuthorizedScope();
    const result = await client.disclosureRequest<unknown>(proof.proofId, '/redactions');
    assertAuthorizedScope();
    const items = readCopies(result, evidenceIds); setCopies(items); return items;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current || app.offline || !canManage) return;
    lock.current = true; setBusy(true); setError(null); setNotice(null);
    try { await auth(); await action(); }
    catch (caught) { if (isCurrent()) setError(caught instanceof Error ? caught.message : 'This request could not finish. Refresh rendering status before retrying.'); }
    finally { lock.current = false; if (isCurrent()) setBusy(false); }
  }
  async function openCopy(item: RedactionCopy) {
    assertAuthorizedScope();
    if (!['READY', 'REVIEWED'].includes(item.status) || !item.sha256 || !mediaKind(item.contentType)) throw new Error('Wait until this copy is ready to review.');
    // No fallback to original media: this endpoint verifies the derivative digest server-side.
    setSource(null); setSourceId(''); setMasks([]); setSourceLoaded(false);
    setLoadedHash(null); setConfirmed(false);
    setReview({ copy: { ...item }, source: { key: `${item.derivativeId}:${item.sha256}:${++previewRevision.current}`, uri: client.redactionReviewUrl(proof.proofId, item.derivativeId), headers: client.authorizedDownloadHeaders(), kind: mediaKind(item.contentType)! } });
  }
  const maskError = (() => { if (!masks.length) return null; try { buildMasks(masks); return null; } catch (caught) { return (caught as Error).message; } })();
  function updateMasks(next: MaskDraft[]) { setMasks(next); setNotice(null); }

  return <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>Private media copies</Text>
    {copy('These copies do not replace original recordings in the shared Proof. Shared Proof links can still include the originals.')}
    {!canManage ? copy('Only the seller can create and approve private copies for this Proof.') : <Button label={expanded ? 'Hide private-copy tools' : 'Create or review a private copy'} variant="secondary" disabled={busy} onPress={() => {
      setExpanded(value => !value);
      if (!expanded) void run(async () => { await refresh(); });
      else { setSource(null); setReview(null); setLoadedHash(null); setConfirmed(false); }
    }} />}
    {expanded && canManage ? <>
      {copy('Opaque masks cover the same regions throughout the entire recording. The server removes audio and metadata from the copy. Review the result before approving it.')}
      {app.offline ? copy('Reconnect to load sources, render copies, or save a review.') : null}
      {error ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.error }]}>{error}</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textPrimary }]}>{notice}</Text> : null}
      {!eligible.length ? copy('A committed image or video is needed before creating a private copy.') : null}
      {eligible.map((item, index) => <Button key={item.evidenceId} label={`Review original ${index + 1} · ${mediaKind(item.contentType)}`} variant="secondary" disabled={disabled || (item.byteSize ?? 0) > MAX_SOURCE_BYTES} onPress={() => void run(async () => {
        if ((item.byteSize ?? 0) > MAX_SOURCE_BYTES) throw new Error('This source exceeds the 250 MB rendering limit.');
        setReview(null); setLoadedHash(null); setConfirmed(false); setMasks([]); setSourceLoaded(false); setSourceId(item.evidenceId);
        setSource({ key: `${item.evidenceId}:${++previewRevision.current}`, uri: client.evidenceContentUrl(proof.proofId, item.evidenceId), headers: client.authorizedDownloadHeaders(), kind: mediaKind(item.contentType)! });
      })} />)}
      {eligible.some(item => (item.byteSize ?? 0) > MAX_SOURCE_BYTES) ? copy('Sources larger than 250 MB cannot be rendered by this tool.') : null}
      {source && selected ? <>
        <Text style={[styles.subtitle, { color: colors.textPrimary }]}>Mark private regions</Text>
        <MediaPreview key={source.key} source={source} label="Original media for private-copy editing" masks={masks} editable={!disabled} onMask={mask => updateMasks([...masks, mask].slice(0, MAX_MASKS))} onLoaded={() => setSourceLoaded(true)} onError={() => { setSourceLoaded(false); setError('The original could not be loaded. Reopen it to refresh access.'); }} />
        {copy('The overlay is an editing guide. Percentages are measured from the top-left corner of the full original frame.')}
        <Button label="Add private-region mask" variant="secondary" disabled={disabled || !sourceLoaded || masks.length >= MAX_MASKS} onPress={() => updateMasks([...masks, defaultMask()])} />
        {masks.map((mask, index) => <View key={index} style={[styles.maskFields, { borderColor: colors.border }]}>
          <Text style={[styles.subtitle, { color: colors.textPrimary }]}>Mask {index + 1}</Text>
          {([['x', 'Left'], ['y', 'Top'], ['width', 'Width'], ['height', 'Height']] as const).map(([field, label]) => <FormField key={field} label={`${label} (%) · mask ${index + 1}`} value={mask[field]} keyboardType="decimal-pad" editable={!disabled} onChangeText={value => updateMasks(masks.map((current, row) => row === index ? { ...current, [field]: value } : current))} />)}
          <Button label={`Remove mask ${index + 1}`} variant="tertiary" disabled={disabled} onPress={() => updateMasks(masks.filter((_, row) => row !== index))} />
        </View>)}
        {maskError ? <Text style={[styles.copy, { color: colors.error }]}>{maskError}</Text> : null}
        <Button label={busy ? 'Requesting private copy…' : 'Render private regions out'} disabled={disabled || !sourceLoaded || !masks.length || !!maskError} onPress={() => void run(async () => {
          const payload = { masks: buildMasks(masks) };
          assertAuthorizedScope();
          const result = await client.disclosureRequest<RedactionCopy>(proof.proofId, `/redactions/${encodeURIComponent(sourceId)}`, 'POST', payload);
          assertAuthorizedScope();
          const items = await refresh();
          const rendered = items.find(item => item.derivativeId === result.derivativeId);
          if (rendered && ['READY', 'REVIEWED'].includes(rendered.status)) await openCopy(rendered);
          else setNotice(rendered ? redactionStatus(rendered) : 'Rendering requested. Refresh the status to check for your copy.');
        })} />
      </> : null}
      <Button label="Refresh rendering status" variant="secondary" disabled={disabled} onPress={() => void run(async () => { await refresh(); })} />
      {copies.map((item, index) => <View key={item.derivativeId} style={{ gap: 8 }}>
        {copy(`Copy ${index + 1}: ${redactionStatus(item)}`)}
        {['READY', 'REVIEWED'].includes(item.status) ? <Button label={`Review rendered copy ${index + 1}`} variant="secondary" disabled={disabled} onPress={() => void run(async () => { await openCopy(item); })} /> : null}
      </View>)}
      {review ? <View style={{ gap: 12 }}>
        <Text style={[styles.subtitle, { color: colors.textPrimary }]}>Review the actual rendered copy</Text>
        <MediaPreview key={review.source.key} source={review.source} label="Server-rendered private copy" onLoaded={() => setLoadedHash(review.copy.sha256)} onError={() => { setLoadedHash(null); setConfirmed(false); setError('The rendered copy could not be loaded. Refresh status and reopen this copy; the original is never substituted.'); }} />
        {copy(review.source.kind === 'video' ? 'Play the entire rendered recording and inspect every masked area. If private information is still visible, return to the original and render new masks.' : 'Inspect the rendered image. If private information is still visible, return to the original and render new masks.')}
        <View style={styles.confirm}><Switch accessibilityLabel="I reviewed the actual rendered copy and checked the private regions" disabled={disabled || !loadedHash} value={confirmed} onValueChange={setConfirmed} /><Text style={[styles.copy, { color: colors.textPrimary, flex: 1 }]}>I reviewed this rendered copy and checked the private regions.</Text></View>
        <Button label="Save reviewed copy" disabled={disabled || !confirmed || !loadedHash} onPress={() => void run(async () => {
          const opened = review.copy;
          const current = (await refresh()).find(item => item.derivativeId === opened.derivativeId);
          const body = approvalBody(opened, current, loadedHash, confirmed);
          assertAuthorizedScope();
          await client.disclosureRequest(proof.proofId, `/redactions/${encodeURIComponent(opened.derivativeId)}/approve`, 'POST', body);
          assertAuthorizedScope(); await refresh();
          setReview(null); setLoadedHash(null); setConfirmed(false);
          setNotice('Reviewed private copy saved. Original recordings are unchanged and can still appear in shared Proof links.');
        })} />
      </View> : null}
    </> : null}
  </View>;
}

function MediaPreview({ source, label, masks = [], editable = false, onMask, onLoaded, onError }: {
  source: PreviewSource; label: string; masks?: MaskDraft[]; editable?: boolean;
  onMask?: (mask: MaskDraft) => void; onLoaded: () => void; onError: () => void;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0), [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [draw, setDraw] = useState(false), [unmeasured, setUnmeasured] = useState(false), [loaded, setLoaded] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const frame = fitMediaFrame(width, dimensions);
  let normalized: RedactionMask[] = [];
  try { normalized = masks.length ? buildMasks(masks) : []; } catch { /* Hide invalid overlays until percentage fields are corrected. */ }
  const receiveDimensions = (value: Dimensions) => { if (fitMediaFrame(100, value)) setDimensions(value); else setUnmeasured(true); };
  const markLoaded = () => { setLoaded(true); onLoaded(); };
  function end(event: GestureResponderEvent) {
    if (start.current && frame && onMask && masks.length < MAX_MASKS) {
      const mask = maskFromDrag(start.current, { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, frame);
      if (mask) onMask(mask);
    }
    start.current = null;
  }
  return <View style={{ gap: 8 }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {onMask ? <Button label={draw ? 'Use playback controls' : 'Draw private regions'} variant="tertiary" disabled={!editable || !loaded || !frame || masks.length >= MAX_MASKS} onPress={() => setDraw(value => !value)} /> : null}
    <View style={{ alignSelf: 'center', position: 'relative', width: frame?.width ?? (width || '100%'), height: frame?.height ?? 240, backgroundColor: '#000000' }}>
      {source.kind === 'image' ? <Image accessibilityLabel={label} source={{ uri: source.uri, headers: source.headers, cache: 'reload' }} resizeMode="contain" style={StyleSheet.absoluteFill} onLoad={event => { receiveDimensions(event.nativeEvent.source); markLoaded(); }} onError={onError} /> :
        <PrivateVideo source={source} label={label} drawing={draw} onLoaded={markLoaded} onError={onError} onDimensions={receiveDimensions} onUnmeasured={() => setUnmeasured(true)} />}
      {frame && loaded ? <View pointerEvents={draw && editable ? 'auto' : 'none'} style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => draw && editable && masks.length < MAX_MASKS}
        onMoveShouldSetResponder={() => draw && editable}
        onResponderGrant={event => { start.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }; }}
        onResponderTerminationRequest={() => false}
        onResponderRelease={end} onResponderTerminate={() => { start.current = null; }}>
        {normalized.map((mask, index) => <View key={index} pointerEvents="none" style={{ position: 'absolute', left: mask.x * frame.width, top: mask.y * frame.height, width: mask.width * frame.width, height: mask.height * frame.height, backgroundColor: '#000000b3', borderColor: '#4fd0ff', borderWidth: 1 }} />)}
      </View> : null}
    </View>
    {onMask && draw && frame ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Drag from one corner of the private region to the opposite corner. The mask applies to every frame.</Text> : null}
    {onMask && unmeasured ? <Text style={[styles.copy, { color: colors.textSecondary }]}>This player could not measure the frame. Use mask percentages; drawing and overlays are unavailable.</Text> : null}
  </View>;
}

function PrivateVideo({ source, label, drawing, onLoaded, onError, onDimensions, onUnmeasured }: {
  source: PreviewSource; label: string; drawing: boolean; onLoaded: () => void; onError: () => void;
  onDimensions: (value: Dimensions) => void; onUnmeasured: () => void;
}) {
  const nativeSource = useMemo(() => ({ uri: source.uri, headers: source.headers }), [source.uri, source.headers]);
  const player = useVideoPlayer(nativeSource, value => { value.loop = false; value.allowsExternalPlayback = false; value.staysActiveInBackground = false; });
  const callbacks = useRef({ onLoaded, onError, onDimensions, onUnmeasured });
  callbacks.current = { onLoaded, onError, onDimensions, onUnmeasured };
  useEffect(() => {
    let active = true, measured = false;
    const status = async () => {
      if (!active) return;
      if (player.status === 'error') { callbacks.current.onError(); return; }
      if (player.status !== 'readyToPlay') return;
      callbacks.current.onLoaded();
      if (measured) return;
      measured = true;
      if (Platform.OS !== 'ios') { callbacks.current.onUnmeasured(); return; }
      try {
        // Expo 52 lacks naturalSize, but its iOS thumbnail generator applies the
        // asset transform. Its dimensions match the full visible video frame.
        const thumbnails = await player.generateThumbnailsAsync(0);
        if (active && thumbnails[0]) callbacks.current.onDimensions({ width: thumbnails[0].width, height: thumbnails[0].height });
        else if (active) callbacks.current.onUnmeasured();
        for (const thumbnail of thumbnails) thumbnail.release();
      } catch { if (active) callbacks.current.onUnmeasured(); }
    };
    const listener = player.addListener('statusChange', () => { void status(); });
    const appState = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
    void status();
    // useVideoPlayer owns disposal; it may already release the native player
    // before this effect cleans up, so do not call player methods here.
    return () => { active = false; listener.remove(); appState.remove(); };
  }, [player]);
  useEffect(() => { if (drawing) player.pause(); }, [drawing, player]);
  return <VideoView accessibilityLabel={label} player={player} contentFit="contain" nativeControls={!drawing} allowsFullscreen={!drawing} allowsPictureInPicture={false} allowsVideoFrameAnalysis={false} style={StyleSheet.absoluteFill} />;
}

const styles = StyleSheet.create({
  panel: { padding: 16, gap: 12, borderRadius: 16, borderWidth: 1 },
  title: { ...typography.sectionTitle }, subtitle: { ...typography.secondaryStrong },
  copy: { ...typography.secondary, lineHeight: 21 },
  maskFields: { gap: 10, padding: 12, borderWidth: 1, borderRadius: 12 },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
