import { useEffect, useRef, useState } from "react";
import { Image, Text, View, Share } from "react-native";
import * as FileSystem from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { VideoReview } from "../ui/VideoReview";
import { RecordedVideo } from "../ui/RecordedVideo";
import { recordPackingEvidence, bindRecordedCapture, saveCaptureBookmarks, listAccountCaptures, persistCaptureMetadata, discardLocalCapture, uploadCaptureFile, type LocalCapture } from "../capture";
import type { UploadTarget } from "../v2-api";
type Media = {
  evidenceId: string;
  contentType: string;
  committedAt: string | null;
};
type Stage = {
  stageId: string;
  type: string;
  actorUserId: string;
  sha256: string | null;
  finalizedAt: string | null;
  evidence: Media[];
};
type Receipt = {
  role: "SELLER" | "BUYER";
  proof: { transaction: { itemTitle: string } };
  stages: Stage[];
};
type Recording = LocalCapture & {
  uri: string;
  contentType: string;
  key: string;
  stageId: string;
  evidenceId?: string;
};
const sequence = ["RECEIPT", "RETURN_PACKING", "RETURN_RECEIPT"];
const titles = ["Document receipt", "Document return packing", "Document returned delivery"];
const statements = ["I_RECORDED_RECEIPT", "I_PACKED_RETURN", "I_RECEIVED_RETURN"];
export function CommerceReceiptScreen() {
  const app = usePackProof(),
    { colors } = useTheme(),
    proofId = app.receiptProofId!;
  const [record, setRecord] = useState<Receipt | null>(null),
    [recording, setRecording] = useState<Recording | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [guides, setGuides] = useState<Array<{ derivativeId: string; transform: { anchorId: string } }>>([]),
    [guideId, setGuideId] = useState<string | null>(null),
    [needsAccept, setNeedsAccept] = useState(false),
    [query, setQuery] = useState(""),
    [people, setPeople] = useState<
      Array<{
        userId: string;
        username: string | null;
        displayName: string | null;
      }>
    >([]),
    [progress, setProgress] = useState<number | null>(null);
  const storageKey = `packproof-receipt:${encodeURIComponent(app.client.apiBaseUrl)}:${app.session!.userId}:${proofId}`;
  const actionLock = useRef(false);
  const request = <T,>(path: string, method = "GET", body?: unknown) =>
    app.client.lifecycleRequest<T>(proofId, path, method, body);
  const reload = async () => {
    await app.ensureAuth();
    setRecord(await request<Receipt>(""));
    setNeedsAccept(false);
    const guideMedia = await app.client.disclosureRequest<{ derivatives: Array<{ derivativeId: string; status: string; transform: { anchorId: string } }> }>(proofId, "/thumbnails").catch(() => ({ derivatives: [] }));
    setGuides(guideMedia.derivatives.filter((item) => item.status === "READY"));
  };
  useEffect(() => {
    void reload().catch((e) => {
      setNeedsAccept(e.status === 403);
      setError(e.message);
    });
    void AsyncStorage.getItem(storageKey)
      .then(async (raw) => {
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.captureUserId === app.session?.userId && saved.captureProofId === proofId) setRecording(saved);
        } else {
          const recovered = (await listAccountCaptures(app.client.apiBaseUrl, app.session!.userId)).find(capture => capture.captureProofId === proofId && capture.captureStageId &&
            !["RECORDING", "FINALIZED"].includes(capture.recovery?.phase ?? ""));
          if (recovered) setRecording({ ...recovered, stageId: recovered.captureStageId!, key: recovered.recovery!.evidenceIdempotencyKey, evidenceId: recovered.uploadEvidenceId });
        }
      })
      .catch(() => undefined);
  }, [proofId]);
  async function run(fn: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await app.ensureAuth();
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Receipt action failed");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  const save = async (value: Recording) => {
    await AsyncStorage.setItem(storageKey, JSON.stringify(value));
    setRecording(value);
  };
  async function capture(index: number) {
    const stage = await request<{ stageId: string }>("/stages", "POST", { type: sequence[index] });
    const video = await recordPackingEvidence({ client: app.client, proofId, userId: app.session!.userId, orderLabel: record?.proof.transaction.itemTitle || "Receipt / return", stageId: stage.stageId, stageType: sequence[index], ...(guideId && index === 2 ? { guide: { uri: app.client.thumbnailUrl(proofId, guideId), headers: app.client.authorizedDownloadHeaders() } } : {}) });
    if (!video) return;
    const key = `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const old = recording;
    await save({ ...video, key, stageId: stage.stageId });
    if (old) await discardLocalCapture(old.uri);
    await reload();
  }
  async function preserve() {
    if (!recording) return;
    const current = await request<Receipt>("");
    let saved = recording;
    if (
      !current.stages
        .flatMap((s) => s.evidence)
        .some((e) => e.evidenceId === saved.evidenceId && e.committedAt)
    ) {
      await bindRecordedCapture(app.client, saved, proofId, app.session!.userId, saved.stageId);
      const initialized = await request<{
        evidenceId: string;
        upload: UploadTarget;
      }>(`/stages/${saved.stageId}/evidence`, "POST", {
        contentType: saved.contentType,
        byteSize: saved.byteSize,
        idempotencyKey: saved.key,
        captureSessionId: saved.captureSessionId,
      });
      saved = { ...saved, evidenceId: initialized.evidenceId, uploadEvidenceId: initialized.evidenceId };
      await save(saved);
      await persistCaptureMetadata(saved);
      await uploadCaptureFile({
        baseUrl: app.apiBaseUrl,
        target: initialized.upload,
        fileUri: saved.uri,
        contentType: saved.contentType,
        onProgress: setProgress,
      });
      await request(`/stages/${saved.stageId}/evidence/${saved.evidenceId}/commit`, "POST", {});
    }
    if (saved.evidenceId) await saveCaptureBookmarks(app.client, proofId, saved.evidenceId, saved).catch(() => undefined);
    await AsyncStorage.removeItem(storageKey);
    setRecording(null);
    if (saved.recovery) saved.recovery.phase = "PRESERVATION_PENDING";
    await persistCaptureMetadata(saved);
    setNotice("Recording received. Its local original remains in Account while preservation is confirmed.");
    await reload();
  }
  return (
    <AppScreen>
      <AppHeader title="Receipt and returns" onBack={app.goBack} />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      ) : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={{ color: colors.textPrimary }}>{notice}</Text> : null}
      {needsAccept ? (
        <Button
          label="Accept receipt invitation"
          loading={busy}
          onPress={() =>
            void run(async () => {
              await request("/accept", "POST", {});
              await reload();
            })
          }
        />
      ) : null}
      {record ? (
        <>
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: 22,
              fontWeight: "600",
            }}
          >
            {record.proof.transaction.itemTitle}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            Receipt and return recordings are added to this Proof. The original packing record stays
            sealed.
          </Text>
          {record.role === "BUYER" ? <View style={{ gap: 10 }}>
            <Text style={{ color: colors.textSecondary }}>Carrier delivery and your receipt report are separate. Notifications are optional and do not mean acceptance.</Text>
            <Button label="Opt in to receipt updates" variant="secondary" disabled={busy} onPress={() => void run(async () => { await app.client.setReceiptPreference(proofId, true); setNotice("Receipt updates enabled for your verified email."); })} />
            <Button label="Turn off receipt updates" variant="tertiary" disabled={busy} onPress={() => void run(async () => { await app.client.setReceiptPreference(proofId, false); setNotice("Receipt updates are turned off."); })} />
          </View> : null}
          {record.role === "SELLER" ? (
            <View style={{ gap: 12 }}>
              <FormField label="Receiver username" value={query} onChangeText={setQuery} />
              <Button
                label="Find receiver"
                variant="secondary"
                disabled={busy || query.trim().length < 2}
                onPress={() =>
                  void run(async () => setPeople((await app.client.searchUsers(query)).users))
                }
              />
              {people.map((person) => (
                <Button
                  key={person.userId}
                  label={`Invite ${person.displayName ?? person.username ?? "receiver"}`}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await request("/receiver", "POST", {
                        userId: person.userId,
                      });
                      setPeople([]);
                      await Share.share({
                        message: `You have a receipt invitation in PackProof. Open Receipt invitations in My Proofs.`,
                      });
                    })
                  }
                />
              ))}
            </View>
          ) : null}
          {record.role === "SELLER" && guides.length ? <View style={{ gap: 8 }}>
            <Text style={{ color: colors.textPrimary }}>Optional guide for returned-item capture</Text>
            <Text style={{ color: colors.textSecondary }}>Choose an outbound frame to help match the angle. The translucent guide is never burned into your incoming evidence.</Text>
            {guides.map((guide, index) => <View key={guide.derivativeId} style={{ gap: 8 }}><Image source={{ uri: app.client.thumbnailUrl(proofId, guide.derivativeId), headers: app.client.authorizedDownloadHeaders() }} style={{ width: "100%", height: 150 }} resizeMode="contain" accessibilityLabel={`Outbound guide frame ${index + 1}`} /><Button label={`${guideId === guide.derivativeId ? "Selected · " : ""}Outbound frame ${index + 1}`} variant="secondary" onPress={() => setGuideId(guideId === guide.derivativeId ? null : guide.derivativeId)} /></View>)}
          </View> : null}
          {sequence.map((type, index) => {
            const stage = record.stages.find((s) => s.type === type),
              previousDone =
                index === 0 ||
                Boolean(record.stages.find((s) => s.type === sequence[index - 1])?.finalizedAt),
              mine = record.role === (index === 2 ? "SELLER" : "BUYER");
            return (
              <View key={type} style={{ gap: 12, paddingVertical: 12 }}>
                <Text
                  style={{
                    color: colors.textPrimary,
                    fontSize: 18,
                    fontWeight: "600",
                  }}
                >
                  {titles[index]}
                </Text>
                {stage?.sha256 ? (
                  <Text selectable style={{ color: colors.textSecondary }}>
                    Finalized · SHA-256 {stage.sha256}
                  </Text>
                ) : (
                  <Text style={{ color: colors.textSecondary }}>
                    {index === 1
                      ? "Show the item, packaging, and return seal."
                      : "Show the unopened package, open it, and show the item and identifying details."}
                  </Text>
                )}
                {stage?.evidence
                  .filter((e) => e.committedAt && e.contentType.startsWith("video/"))
                  .map((media) => (
                    <RecordedVideo
                      key={media.evidenceId}
                      uri={app.client.lifecycleEvidenceUrl(
                        proofId,
                        stage.stageId,
                        media.evidenceId,
                      )}
                      token={app.session!.token}
                    />
                  ))}
                {mine && previousDone && !stage?.finalizedAt ? (
                  <>
                    <Button
                      label={recording?.stageId === stage?.stageId ? "Retake recording" : "Record"}
                      variant="secondary"
                      disabled={busy || Boolean(recording?.evidenceId)}
                      onPress={() => void run(() => capture(index))}
                    />
                    {stage?.evidence.some((e) => !e.committedAt) ? (
                      <Button
                        label="Discard unfinished upload"
                        variant="tertiary"
                        disabled={busy}
                        onPress={() =>
                          void run(async () => {
                            for (const media of stage.evidence.filter((e) => !e.committedAt))
                              await request(
                                `/stages/${stage.stageId}/evidence/${media.evidenceId}/discard`,
                                "POST",
                                {},
                              );
                            await AsyncStorage.removeItem(storageKey);
                            if (recording)
                              await discardLocalCapture(recording.uri);
                            setRecording(null);
                            await reload();
                          })
                        }
                      />
                    ) : null}
                    {stage?.evidence.length && stage.evidence.every((e) => e.committedAt) ? (
                      <Button
                        label="I confirm this recording · Finalize stage"
                        disabled={busy}
                        onPress={() =>
                          void run(async () => {
                            await request(`/stages/${stage.stageId}/finalize`, "POST", {
                              statement: statements[index],
                            });
                            await reload();
                          })
                        }
                      />
                    ) : null}
                  </>
                ) : null}
              </View>
            );
          })}
        </>
      ) : null}
      {recording ? (
        <View style={{ gap: 12 }}>
          <VideoReview uri={recording.uri} />
          <Button
            label={
              busy
                ? `Preserving recording${progress == null ? "" : ` · ${progress}%`}`
                : "Use recording / retry upload"
            }
            loading={busy}
            onPress={() => void run(preserve)}
          />
          <Text style={{ color: colors.textSecondary }}>
            The recording is saved on this device until preservation succeeds.
          </Text>
        </View>
      ) : null}
    </AppScreen>
  );
}
