import { AppModal } from "../ui/AppModal";
import { useEffect, useRef, useState } from 'react';
import { AppState, Image, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { toByteArray } from 'base64-js';
import { cancelDocumentPreview, previewDocument } from '../../modules/packproof-document-preview';
import type { PackProofV2Client } from '../v2-api';
import { newIdempotencyKey } from '../v2-api';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { DateField } from '../ui/DateField';
import { InfoCard } from '../ui/ProofCard';
import { useTheme } from '../theme/ThemeProvider';
import { SelectionRow } from './SelectionRow';
import { approveRecipientPreparation, assertCurrent, digestValue, profilesFrom, recipientApprovalBody, recipientFailure, recipientJobFrom, recipientRequest, scoped, verifyRecipientBytes, type RecipientFrame, type RecipientJob, type RecipientProfile, type VerifiedPreview } from './workflows';

export function RecipientExportPanel({ api, userId, proofId, caseId, sources, isCurrent, ensureAuth }: {
  api: PackProofV2Client; userId: string; proofId: string; caseId: string;
  sources: Array<{ evidenceId: string; contentType: string }>;
  isCurrent: () => boolean; ensureAuth: () => Promise<void>;
}) {
  const { colors } = useTheme();
  const dimensions = useWindowDimensions();
  const storageKey = `packproof.recipient-export.${digestValue([api.apiBaseUrl, userId, proofId, caseId])}`;
  const [profiles, setProfiles] = useState<RecipientProfile[]>([]), [profileId, setProfileId] = useState('');
  const [frames, setFrames] = useState<RecipientFrame[]>([]), [narrative, setNarrative] = useState('');
  const [date, setDate] = useState(''), [time, setTime] = useState(''), [instructions, setInstructions] = useState(false);
  const [job, setJob] = useState<RecipientJob | null>(null), [retryId, setRetryId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<VerifiedPreview[]>([]), [legible, setLegible] = useState(false);
  const [imagePreview, setImagePreview] = useState<VerifiedPreview | null>(null), [imageRatio, setImageRatio] = useState(4 / 3);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [previewRevision, setPreviewRevision] = useState(0);
  const mounted = useRef(true), busyRef = useRef(false), version = useRef(0), requestKey = useRef(newIdempotencyKey());
  const nativePreview = useRef<string | null>(null);
  const owned = useRef(new Set<string>()), fileUsers = useRef(0), directory = useRef(`${FileSystem.cacheDirectory}packproof-signature-${digestValue(storageKey).slice(0, 16)}-${newIdempotencyKey().replace(/[^A-Za-z0-9_-]/g, '')}/`);
  const currentRef = useRef(isCurrent); currentRef.current = isCurrent;
  const current = () => {
    if (!mounted.current || !currentRef.current()) return false;
    try { api.assertCaptureAccount(userId, api.apiBaseUrl); return true; } catch { return false; }
  };
  const active = () => current() && AppState.currentState === 'active';
  const recordings = sources.filter(source => source.contentType.startsWith('video/'));
  const path = 'recipient-exports';
  const text = { color: colors.textSecondary, fontSize: 15, lineHeight: 21 };
  async function cleanup() { if (fileUsers.current) return; for (const uri of owned.current) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined); owned.current.clear(); await FileSystem.deleteAsync(directory.current, { idempotent: true }).catch(() => undefined); }
  async function usingFiles<T>(action: () => Promise<T>): Promise<T> {
    fileUsers.current++;
    try { return await action(); }
    finally { fileUsers.current--; if (!current()) await cleanup(); }
  }
  function cancelPreview() { const uri = nativePreview.current; if (uri) void cancelDocumentPreview(uri).catch(() => undefined); }
  async function run(action: (revision: number) => Promise<void>) {
    if (busyRef.current || !current()) return;
    const revision = version.current; busyRef.current = true; setBusy(true); setError(null);
    try { await scoped(active, ensureAuth); await action(revision); }
    catch (cause) { if (current() && revision === version.current) setError(cause instanceof Error ? cause.message : 'This preparation could not finish. Retry shortly.'); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  }
  async function publish(value: RecipientJob, revision: number) {
    if (!current() || revision !== version.current) return;
    setJob(value); setRetryId(value.jobId);
    await AsyncStorage.setItem(storageKey, value.jobId).catch(() => undefined);
  }
  function changed() {
    version.current++; requestKey.current = newIdempotencyKey(); setJob(null); setRetryId(null); setPreviews([]); setImagePreview(null); setLegible(false); setError(null);
    void AsyncStorage.removeItem(storageKey).catch(() => undefined);
  }
  async function loadProfiles() {
    const response = await scoped(active, () => api.featureRequest<unknown>(proofId, `${path}/profiles`));
    const available = profilesFrom(response); setProfiles(available); setProfileId(available.find(profile => !profile.reviewRequired)?.id ?? '');
  }
  async function readJob(id: string, revision: number) {
    const response = await scoped(active, () => api.featureRequest<unknown>(proofId, `${path}/${encodeURIComponent(id)}`));
    await publish(recipientJobFrom(response, proofId, caseId), revision);
  }
  useEffect(() => {
    mounted.current = true;
    void run(async revision => {
      await loadProfiles();
      const saved = await scoped(active, () => AsyncStorage.getItem(storageKey));
      if (saved && /^[A-Za-z0-9_-]{1,200}$/.test(saved)) { setRetryId(saved); await readJob(saved, revision); }
    });
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') { cancelPreview(); setImagePreview(null); } });
    return () => { mounted.current = false; version.current++; listener.remove(); cancelPreview(); void cleanup(); };
  }, [api, proofId, caseId, userId]);
  useEffect(() => {
    if (!job || !['QUEUED', 'RENDERING'].includes(job.state)) return;
    let active = true, running = false, attempts = 0;
    const revision = version.current;
    const timer = setInterval(() => {
      if (!active || !current() || AppState.currentState !== 'active' || busyRef.current || running || attempts++ >= 100) return;
      running = true;
      void readJob(job.jobId, revision).catch(cause => { if (active && current() && revision === version.current) setError(cause instanceof Error ? cause.message : 'Check preparation again.'); }).finally(() => { running = false; });
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [job?.jobId, job?.state, api, proofId]);
  useEffect(() => {
    setPreviews([]); setLegible(false);
    if (job?.state !== 'READY' || !job.artifact) return;
    let previewActive = true;
    const revision = version.current;
    const stillCurrent = () => previewActive && current() && AppState.currentState === 'active' && revision === version.current;
    void usingFiles(async () => {
      await scoped(stillCurrent, ensureAuth);
      await FileSystem.makeDirectoryAsync(directory.current, { intermediates: true });
      const verified: VerifiedPreview[] = [];
      for (const [index, file] of job.artifact!.files.entries()) {
        assertCurrent(stillCurrent);
        const uri = `${directory.current}${job.jobId}-${previewRevision}-${file.name}`; owned.current.add(uri);
        const download = await FileSystem.downloadAsync(api.featureDownloadUrl(proofId, `${path}/${job.jobId}/files/${index}?preview=true`), uri, { headers: api.authorizedDownloadHeaders() });
        assertCurrent(stillCurrent);
        if (download.status !== 200) throw new Error('The exact prepared preview is unavailable. Check preparation again.');
        const bytes = toByteArray(await scoped(stillCurrent, () => FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })));
        verifyRecipientBytes(bytes, file);
        verified.push({ ...file, uri, viewed: false });
      }
      assertCurrent(stillCurrent); setPreviews(verified);
    }).catch(cause => { if (stillCurrent()) { setPreviews([]); setError(cause instanceof Error ? cause.message : 'The exact files could not be verified.'); } });
    return () => { previewActive = false; };
  }, [job?.jobId, job?.state, job?.artifactSha256, previewRevision]);
  async function openPreview(preview: VerifiedPreview) {
    nativePreview.current = preview.uri;
    try {
      await usingFiles(async () => {
        const shown = await scoped(active, () => previewDocument(preview.uri, preview.name));
        if (!shown) throw new Error('This build cannot display the exact PDF. Install the current PackProof build before approving these files.');
        setPreviews(values => values.map(file => file.uri === preview.uri ? { ...file, viewed: true } : file));
      });
    } finally { if (nativePreview.current === preview.uri) nativePreview.current = null; }
  }
  const deadline = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? `${date}T${time}:00` : '';
  function draft() { return recipientRequest({ caseId, profile: profiles.find(profile => profile.id === profileId), frames, sourceIds: recordings.map(source => source.evidenceId), narrative, deadline, instructionsReviewed: instructions, idempotencyKey: requestKey.current }); }
  let canPrepare = false; try { draft(); canPrepare = true; } catch { /* Form provides the required fields below. */ }
  let canApprove = false; try { if (job) { recipientApprovalBody(job, previews, legible); canApprove = true; } } catch { /* Every file must be viewed first. */ }
  return <InfoCard>
    <AppModal visible={!!imagePreview} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setImagePreview(null)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: 16, gap: 8 }}><Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '700' }}>{imagePreview?.name}</Text><Text style={text}>Pinch to zoom and inspect the exact prepared image.</Text><Button label="Close image preview" variant="secondary" onPress={() => setImagePreview(null)} /></View>
        <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent contentContainerStyle={{ paddingHorizontal: 16 }}>
          {imagePreview ? <Image source={{ uri: imagePreview.uri }} accessibilityLabel={`Exact submission image ${imagePreview.name}`} resizeMode="contain" style={{ width: dimensions.width - 32, height: (dimensions.width - 32) * imageRatio }} onLoad={event => {
            if (!active()) return;
            const { width, height } = event.nativeEvent.source;
            if (width > 0 && height > 0) setImageRatio(height / width);
            setPreviews(values => values.map(value => value.uri === imagePreview.uri ? { ...value, viewed: true } : value));
          }} onError={() => {
            if (!current()) return;
            setPreviews(values => values.map(value => value.uri === imagePreview.uri ? { ...value, viewed: false } : value));
            setImagePreview(null); setError('This exact image could not be displayed. Reload the preview before approving.');
          }} /> : null}
        </ScrollView>
      </SafeAreaView>
    </AppModal>
    <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontSize: 20, fontWeight: '700' }}>Prepare submission files</Text>
    <Text style={text}>Choose the instructions for your actual case, select relevant moments, and review the finished files.</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text> : null}
    {!profiles.length ? <Button label="Reload submission formats" variant="secondary" disabled={busy} onPress={() => void run(loadProfiles)} /> : null}
    {profiles.map(profile => <SelectionRow key={profile.id} selected={profileId === profile.id} disabled={busy || profile.reviewRequired} label={`${profile.destination === 'EBAY_PAYMENT_DISPUTE' ? 'eBay payment dispute · images' : `Stripe dispute · ${profile.network === 'MASTERCARD' ? 'Mastercard' : 'other networks'} · PDF`} · ${profile.region}${profile.reviewRequired ? ' · needs updated format review' : ''}`} onPress={() => { changed(); setProfileId(profile.id); }} />)}
    <View pointerEvents={busy ? 'none' : 'auto'}><DateField label="Submission deadline from your case" value={date} onChange={value => { changed(); setDate(value); }} /></View>
    <FormField label="Deadline time · your phone’s local time (24-hour HH:MM)" value={time} placeholder="17:00" editable={!busy} onChangeText={value => { changed(); setTime(value.slice(0, 5)); }} />
    <SelectionRow selected={instructions} disabled={busy} label="I checked the current instructions and deadline for this case." onPress={() => { changed(); setInstructions(!instructions); }} />
    {frames.map((frame, index) => <View key={index} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 10 }}>
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '700' }}>Source frame {index + 1}</Text>
      {recordings.map((source, i) => <SelectionRow key={source.evidenceId} label={`Recording ${i + 1}`} selected={frame.evidenceId === source.evidenceId} disabled={busy} onPress={() => { changed(); setFrames(rows => rows.map((row, at) => at === index ? { ...row, evidenceId: source.evidenceId } : row)); }} />)}
      <FormField label="Time in recording (seconds)" value={frame.seconds} keyboardType="decimal-pad" editable={!busy} onChangeText={value => { changed(); setFrames(rows => rows.map((row, at) => at === index ? { ...row, seconds: value.slice(0, 12) } : row)); }} />
      <FormField label="Factual label for this frame" value={frame.label} editable={!busy} onChangeText={value => { changed(); setFrames(rows => rows.map((row, at) => at === index ? { ...row, label: value.slice(0, 120) } : row)); }} />
      <Button label="Remove this frame" variant="tertiary" disabled={busy} onPress={() => { changed(); setFrames(rows => rows.filter((_, at) => at !== index)); }} />
    </View>)}
    <Button label="Add a source frame" variant="secondary" disabled={busy || !recordings.length || frames.length >= 4} onPress={() => { changed(); setFrames(rows => [...rows, { evidenceId: recordings[0].evidenceId, seconds: '0', label: '' }]); }} />
    {!recordings.length ? <Text style={text}>Include a recording in the case packet to prepare source frames.</Text> : null}
    <FormField label="Supporting text · your statement" value={narrative} multiline editable={!busy} onChangeText={value => { changed(); setNarrative(value.slice(0, 2000)); }} />
    <Button label="Prepare exact files" disabled={busy || !canPrepare} onPress={() => void run(async revision => { const response = await scoped(active, () => api.featureRequest<unknown>(proofId, path, 'POST', draft())); await publish(recipientJobFrom(response, proofId, caseId), revision); })} />
    {job && ['QUEUED', 'RENDERING'].includes(job.state) ? <Text accessibilityRole="text" style={text}>Your files are being prepared. This panel checks progress while open.</Text> : null}
    {retryId ? <Button label="Check preparation again" variant="secondary" disabled={busy} onPress={() => void run(async revision => { await readJob(retryId, revision); setPreviewRevision(value => value + 1); })} /> : null}
    {job?.state === 'FAILED' ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{recipientFailure(job.failureCode)}</Text> : null}
    {job?.state === 'READY' && job.artifact ? <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}>Exact files for approval</Text>
      {job.artifact.files.map(file => {
        const preview = previews.find(value => value.name === file.name);
        return <View key={file.name} style={{ gap: 8 }}><Text style={text}>{file.name} · {(file.byteSize / 1000).toFixed(0)} KB</Text>
          {preview ? file.contentType === 'application/pdf' ? <Button label={`${preview.viewed ? 'Reopen' : 'Open'} exact PDF · ${file.name}`} variant="secondary" disabled={busy} onPress={() => void run(() => openPreview(preview))} /> : <><Image source={{ uri: preview.uri }} accessibilityLabel={`Submission image thumbnail ${file.name}`} resizeMode="contain" style={{ width: '100%', height: 250, backgroundColor: colors.surface }} /><Button label={`${preview.viewed ? 'Reopen' : 'Open'} exact image · zoom to inspect`} variant="secondary" disabled={busy} onPress={() => void run(async () => { assertCurrent(active); setImagePreview(preview); })} /></> : <Text style={text}>Downloading and checking the exact file…</Text>}
        </View>;
      })}
      <Text selectable style={text}>{job.artifact.approvedNarrative}</Text>
      {job.artifact.gaps.map((gap, index) => <Text key={index} style={text}>• {gap}</Text>)}
      {!job.approval ? <SelectionRow selected={legible} disabled={busy || previews.some(preview => !preview.viewed) || previews.length !== job.artifact.files.length} label="I reviewed these exact files and text; the relevant details are readable." onPress={() => setLegible(!legible)} /> : null}
      <Button label={job.approval ? 'Download approved files again' : 'Approve and download files'} disabled={busy || (!job.approval && !canApprove)} onPress={() => void run(async revision => usingFiles(async () => {
        const approved = await approveRecipientPreparation({ job, previews, legible, userId, current: active, approve: (id, body) => api.featureRequest<unknown>(proofId, `${path}/${id}/approve`, 'POST', body) });
        await publish(approved, revision);
        assertCurrent(active);
        const uri = `${directory.current}PackProof-${job.jobId}.zip`; owned.current.add(uri);
        await FileSystem.makeDirectoryAsync(directory.current, { intermediates: true });
        const downloaded = await scoped(active, () => FileSystem.downloadAsync(api.featureDownloadUrl(proofId, `${path}/${job.jobId}/download`), uri, { headers: api.authorizedDownloadHeaders() }));
        if (downloaded.status !== 200) throw new Error('The approved download is unavailable. Check preparation again.');
        if (!(await scoped(active, () => Sharing.isAvailableAsync()))) throw new Error('Saving or sharing files is unavailable on this device.');
        await scoped(active, () => Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: 'Save approved submission files' }));
      }))} />
      <Text style={text}>Upload the files in the submission folder to your case. PackProof has not submitted a dispute or confirmed portal acceptance.</Text>
    </View> : null}
  </InfoCard>;
}
