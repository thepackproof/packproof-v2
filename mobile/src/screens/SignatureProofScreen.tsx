import { useEffect, useRef, useState } from "react";
import { AppState, RefreshControl, ScrollView, Text, View } from "react-native";
import { PressableScale, FadeSlideIn } from "../ui/motion";
import * as FileSystem from "expo-file-system";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { InfoCard } from "../ui/ProofCard";
import { CasePacketPreview } from "../ui/CasePacketPreview";
import { PairedReturnPlayer } from "../ui/PairedReturnPlayer";
import { SignaturePlayer } from "../ui/SignaturePlayer";
import { RestoringScrollView } from "../ui/RestoringScrollView";
import { newIdempotencyKey } from "../v2-api";
import { ItemHistoryPanel } from "../signature/ItemHistoryPanel";
import { RecipientExportPanel } from "../signature/RecipientExportPanel";
import { SelectionRow } from "../signature/SelectionRow";
import { assertCurrent, CASE_FIELDS, caseScope, digestValue, scoped, type CaseField } from "../signature/workflows";
import {
  elapsedLabel,
  mediaUri,
  type CasePreview,
  type EvidenceAnchor,
  type ProofAnswer,
  type SignatureEvidence,
  type SignatureView,
} from "../signature";

const templates = [
  ["MISSING_CONTENTS", "Reported missing contents"],
  ["WRONG_ITEM", "Reported wrong item"],
  ["CONDITION_RETURN", "Reported condition / return difference"],
] as const;
const proofTools = [
  { key: "replay", label: "Recordings" },
  { key: "ask", label: "Questions" },
  { key: "case", label: "Case packet" },
  { key: "compare", label: "Compare" },
  { key: "history", label: "Item history" },
] as const;
type ProofTool = typeof proofTools[number]["key"];

const prompts = [
  "What item is in this order?",
  "What does the carrier report?",
  "Where is the identifier shown?",
  "What recordings are available?",
];
export function SignatureProofScreen() {
  const app = usePackProof();
  const scope = JSON.stringify([app.client.apiBaseUrl, app.session?.userId, app.proof?.proofId]);
  const currentScope = useRef(scope); currentScope.current = scope;
  return <ScopedSignatureProofScreen key={scope} scope={scope} currentScope={() => currentScope.current} />;
}
function ScopedSignatureProofScreen({ scope, currentScope }: { scope: string; currentScope: () => string }) {
  const app = usePackProof(),
    { colors } = useTheme(),
    proofId = app.proof?.proofId;
  const [tool, setTool] = useState<ProofTool>("replay");
  const [returnToAnswer, setReturnToAnswer] = useState(false);
  const toolOffsets = useRef<Record<ProofTool, number>>({ replay: 0, ask: 0, case: 0, compare: 0, history: 0 });
  function selectTool(next: ProofTool) {
    setReturnToAnswer(false);
    setTool(next);
  }
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [record, setRecord] = useState<SignatureView | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState(""),
    [answer, setAnswer] = useState<ProofAnswer | null>(null);
  const [selected, setSelected] = useState<EvidenceAnchor | null>(null),
    [source, setSource] = useState<SignatureEvidence | null>(null);
  const [mark, setMark] = useState<{
      evidence: SignatureEvidence;
      startMs: number;
      endMs: number;
    } | null>(null),
    [label, setLabel] = useState("");
  const [packet, setPacket] = useState<CasePreview | null>(null),
    [notes, setNotes] = useState("");
  const [fields, setFields] = useState<CaseField[]>([...CASE_FIELDS]);
  const [mediaIds, setMediaIds] = useState<string[] | null>(null);
  const [left, setLeft] = useState<SignatureEvidence | null>(null),
    [right, setRight] = useState<SignatureEvidence | null>(null);
  const [outboundAnchor, setOutboundAnchor] = useState<EvidenceAnchor | null>(
      null,
    ),
    [inboundAnchor, setInboundAnchor] = useState<EvidenceAnchor | null>(null),
    [correcting, setCorrecting] = useState<string | null>(null);
  const [comparisonNotes, setComparisonNotes] = useState(""),
    [comparisonState, setComparisonState] = useState("NOT_COMPARABLE");
  const live = useRef(true),
    busyRef = useRef(false);
  const [sourceDetail, setSourceDetail] = useState<string | null>(null);
  const isCurrent = () => {
    if (!live.current || currentScope() !== scope || !app.session) return false;
    try { app.client.assertCaptureAccount(app.session.userId, app.client.apiBaseUrl); return true; } catch { return false; }
  };
  const isActive = () => isCurrent() && AppState.currentState === 'active';
  const request = <T,>(path = "", method = "GET", body?: unknown) =>
    scoped(isActive, () => app.client.signatureRequest<T>(proofId!, path, method, body));
  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await scoped(isActive, app.ensureAuth);
      await fn();
    } catch (e) {
      if (isCurrent())
        setError(
          e instanceof Error
            ? e.message
            : "This action is unavailable. Your original Proof is preserved.",
        );
    } finally {
      busyRef.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  async function reload() {
    const next = await request<SignatureView>();
    if (isCurrent()) {
      setRecord(next);
      setPacket(null);
      setMediaIds(ids => ids === null ? next.snapshot.data.evidence.map(item => item.evidenceId) : ids.filter(id => next.snapshot.data.evidence.some(item => item.evidenceId === id)));
      setSource(
        (current) =>
          next.snapshot.data.evidence.find(
            (item) => item.evidenceId === current?.evidenceId,
          ) ??
          next.snapshot.data.evidence.find((item) =>
            item.contentType.startsWith("video/"),
          ) ??
          null,
      );
      const media = await scoped(isActive, () => app.client
        .disclosureRequest<{
          derivatives: Array<{
            derivativeId: string;
            status: string;
            transform: { anchorId: string };
          }>;
        }>(proofId!, "/thumbnails"))
        .catch(() => ({ derivatives: [] }));
      if (isCurrent())
        setThumbnails(
          Object.fromEntries(
            media.derivatives
              .filter((item) => item.status === "READY")
              .map((item) => [
                item.transform.anchorId,
                app.client.thumbnailUrl(proofId!, item.derivativeId),
              ]),
          ),
        );
    }
  }

  useEffect(() => {
    live.current = true;
    if (proofId) void run(reload);
    return () => {
      live.current = false;
    };
  }, [proofId]);
  useEffect(() => { if (app.route.historyShareId) setTool('history'); }, [app.route.historyShareId]);
  if (!proofId || !app.session)
    return (
      <AppScreen>
        <AppHeader title="Proof tools" onBack={app.goBack} />
      </AppScreen>
    );
  const videos =
    record?.snapshot.data.evidence.filter((item) =>
      item.contentType.startsWith("video/"),
    ) ?? [];
  function openCitation(citation: ProofAnswer["citations"][number]) {
    const anchor = record?.snapshot.data.anchors.find(
      (item) => item.anchorId === citation.id,
    );
    const media = record?.snapshot.data.evidence.find(
      (item) => item.evidenceId === (anchor?.evidenceId ?? citation.id),
    );
    if (media) {
      toolOffsets.current.replay = 0;
      selectTool("replay");
      setReturnToAnswer(true);
      setSource(media);
      setSelected(anchor ?? null);
    } else {
      const event = (app.proof?.chronology ?? []).find(
        (item) =>
          item.id === citation.id || item.relatedEntityId === citation.id,
      );
      if (event) {
        setSourceDetail(
          `${event.title} · ${event.occurredAt} · ${event.source}\n${event.description ?? ""}`,
        );
      }
    }
  }
  return (
    <AppScreen scroll={false}>
      <AppHeader title="Proof tools" onBack={app.goBack} />
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityRole="tablist" accessibilityLabel="Proof tools">
          {proofTools.map(item => <PressableScale key={item.key} accessibilityRole="tab" accessibilityState={{ selected: tool === item.key }} onPress={() => selectTool(item.key)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderBottomWidth: 2, borderBottomColor: tool === item.key ? colors.accent : "transparent" }}>
            <Text style={{ color: tool === item.key ? colors.accentText : colors.textSecondary, fontWeight: tool === item.key ? "700" : "400" }}>{item.label}</Text>
          </PressableScale>)}
        </ScrollView>
      </View>
      <FadeSlideIn key={tool} style={{ flex: 1, minHeight: 0 }}>
      <RestoringScrollView contentContainerStyle={{ gap: 16, paddingBottom: 20 }} initialOffsetY={toolOffsets.current[tool]} restorationReady={record !== null} onScrollOffset={offset => { toolOffsets.current[tool] = offset; }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void run(reload)} tintColor={colors.accent} colors={[colors.accent]} />}>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      ) : null}
      {record ? (
        <>
          {tool === "replay" ? <>
          {returnToAnswer ? <Button label="Back to answer" variant="tertiary" onPress={() => selectTool("ask")} /> : null}
          <Text style={{ color: colors.textSecondary }}>Review original recordings and bookmark useful moments.</Text>
          {videos.map((media, index) => (
            <Button
              key={media.evidenceId}
              label={`${media.stageId ? "Receipt / return" : "Packing"} recording ${index + 1}${source?.evidenceId === media.evidenceId ? " · selected" : ""}`}
              variant="secondary"
              onPress={() => {
                setSource(media);
                setSelected(null);
              }}
            />
          ))}
          {source ? (
            <SignaturePlayer
              key={source.evidenceId}
              uri={mediaUri(app.client, proofId, source)}
              token={app.session.token}
              selection={selected}
              thumbnails={thumbnails}
              anchors={record.snapshot.data.anchors.filter(
                (item) => item.evidenceId === source.evidenceId,
              )}
              onMoment={
                record.capabilities?.replay === false
                  ? undefined
                  : (startMs) => {
                      const endMs = Math.min(
                        startMs + 1000,
                        source.capturedDurationMs ?? startMs + 1000,
                      );
                      if (endMs <= startMs) {
                        setError(
                          "Move slightly before the end of the recording to bookmark a visible moment.",
                        );
                        return;
                      }
                      setMark({
                        evidence: source,
                        startMs,
                        endMs: Math.floor(endMs),
                      });
                      setLabel("");
                    }
              }
            />
          ) : (
            <Text style={{ color: colors.textSecondary }}>
              No saved recording is available yet.
            </Text>
          )}
          {mark ? (
            <InfoCard>
              <Text style={{ color: colors.textPrimary }}>
                Mark {elapsedLabel(mark.startMs)} in the original
              </Text>
              <FormField
                label="Describe the visible moment"
                value={label}
                onChangeText={setLabel}
                placeholder="Identifier shown"
              />
              <Text style={{ color: colors.textSecondary }}>
                Your description is a user-marked observation, not an
                independent finding.
              </Text>
              <Button
                label="Save bookmark"
                disabled={!label.trim() || busy}
                onPress={() =>
                  void run(async () => {
                    const added = await request<{ anchorId: string }>(
                      "/anchors",
                      "POST",
                      {
                        evidenceId: mark.evidence.evidenceId,
                        stageId: mark.evidence.stageId,
                        startMs: mark.startMs,
                        endMs: mark.endMs,
                        label: label.trim(),
                        sourceType: "USER_MARKED",
                        idempotencyKey: newIdempotencyKey(),
                      },
                    );
                    if (!mark.evidence.stageId)
                      await app.client
                        .disclosureRequest(
                          proofId,
                          `/thumbnails/${encodeURIComponent(added.anchorId)}`,
                          "POST",
                          {},
                        )
                        .catch(() => undefined);
                    setMark(null);
                    await reload();
                  })
                }
              />
              <Button
                label="Cancel bookmark"
                variant="tertiary"
                onPress={() => setMark(null)}
              />
            </InfoCard>
          ) : null}
          </> : null}
          {tool === "ask" ? <>
          <InfoCard>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: 20,
                fontWeight: "600",
              }}
            >
              Find evidence
            </Text>
            <Text style={{ color: colors.textSecondary }}>
              {record.capabilities?.ask === false
                ? "Questions are temporarily unavailable. Original evidence is still accessible."
                : "Ask a question about this Proof. Answers link to the available evidence."}
            </Text>
            {prompts.map((prompt) => (
              <Button
                key={prompt}
                label={prompt}
                variant="secondary"
                disabled={busy}
                onPress={() => setQuestion(prompt)}
              />
            ))}
            <FormField
              label="Your question"
              value={question}
              onChangeText={setQuestion}
            />
            <Button
              label="Find supporting evidence"
              disabled={
                busy || !question.trim() || record.capabilities?.ask === false
              }
              onPress={() =>
                void run(async () =>
                  setAnswer(
                    await request<ProofAnswer>("/ask", "POST", {
                      snapshotId: record.snapshot.snapshotId,
                      question: question.trim(),
                    }),
                  ),
                )
              }
            />
            {answer ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.textPrimary }}>
                  {answer.answer}
                </Text>
                <Text style={{ color: colors.textSecondary }}>
                  {answer.state === "NOT_ESTABLISHED"
                    ? "Not established by this record"
                    : "Evidence assistance · sources below"}
                </Text>
                {answer.citations.map((citation, index) => (
                  <View key={`${citation.kind}:${citation.id}:${index}`}>
                    <Text selectable style={{ color: colors.textSecondary }}>
                      {citation.label} · {citation.source}
                    </Text>
                    {["MEDIA", "ANCHOR", "EVENT"].includes(citation.kind) ? (
                      <Button
                        label={`Open source: ${citation.label}`}
                        variant="secondary"
                        onPress={() => openCitation(citation)}
                      />
                    ) : (
                      <Text selectable style={{ color: colors.textSecondary }}>
                        Snapshot field: {citation.id}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ) : null}
          </InfoCard>
          {sourceDetail ? (
            <InfoCard>
              <Text selectable style={{ color: colors.textPrimary }}>
                {sourceDetail}
              </Text>
              <Button
                label="Close source detail"
                variant="tertiary"
                onPress={() => setSourceDetail(null)}
              />
            </InfoCard>
          ) : null}
          </> : null}
          {tool === "case" ? <>
          <InfoCard>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: 20,
                fontWeight: "600",
              }}
            >
              Build a case packet
            </Text>
            <Text style={{ color: colors.textSecondary }}>
              Select the reported issue. Review every field before approving an
              export; nothing is sent automatically.
            </Text>
            <FormField
              label="Your factual notes (optional)"
              value={notes}
              editable={!busy}
              onChangeText={(value) => {
                setNotes(value.slice(0, 4000));
                setPacket(null);
              }}
              multiline
            />
            <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>Fields to include</Text>
            {CASE_FIELDS.map(field => <SelectionRow key={field} label={field === 'status' ? 'Proof status' : field === 'order' ? 'Order details' : field === 'shipping' ? 'Shipping events' : field === 'evidence' ? 'Evidence and source moments' : 'Participant statements'} selected={fields.includes(field)} disabled={busy} onPress={() => { setPacket(null); setFields(values => values.includes(field) ? values.filter(value => value !== field) : [...values, field]); }} />)}
            {fields.includes('evidence') ? record.snapshot.data.evidence.map((evidence, index) => <SelectionRow key={evidence.evidenceId} label={`Include source ${index + 1} · ${evidence.stageId ? 'Receipt / return' : 'Outbound'} · ${evidence.contentType}`} selected={(mediaIds ?? []).includes(evidence.evidenceId)} disabled={busy} onPress={() => { setPacket(null); setMediaIds(values => (values ?? []).includes(evidence.evidenceId) ? (values ?? []).filter(id => id !== evidence.evidenceId) : [...(values ?? []), evidence.evidenceId]); }} />) : null}
            {templates.map(([template, title]) => (
              <Button
                key={template}
                label={title}
                variant="secondary"
                disabled={busy || record.capabilities?.cases === false}
                onPress={() =>
                  void run(async () =>
                    setPacket(
                      await request<CasePreview>("/cases", "POST", {
                        snapshotId: record.snapshot.snapshotId,
                        template,
                        ...(notes.trim() ? { notes: notes.trim() } : {}),
                        scope: caseScope(fields, mediaIds ?? [], record.snapshot.data.evidence.map(item => item.evidenceId)),
                      }),
                    ),
                  )
                }
              />
            ))}
          </InfoCard>
            {packet ? (
              <View style={{ gap: 16 }}>
                <CasePacketPreview key={packet.caseId} packet={packet} />
                <Button
                  label={
                    packet.approved
                      ? "Export approved packet"
                      : "Approve this exact packet"
                  }
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      if (!packet.approved) {
                        if (digestValue(packet.preview) !== packet.sha256) throw new Error('The case preview no longer matches its saved hash. Build the packet again.');
                        const approved = await request<CasePreview>(
                          `/cases/${encodeURIComponent(packet.caseId)}/approve`,
                          "POST",
                          { previewSha256: packet.sha256 },
                        );
                        if (approved.caseId !== packet.caseId || approved.sha256 !== packet.sha256 || !approved.approved) throw new Error('Approval was not confirmed for this exact packet.');
                        setPacket(approved);
                        return;
                      }
                      const uri = `${FileSystem.cacheDirectory}PackProof-case-${packet.caseId.replace(/[^a-zA-Z0-9_-]/g, "")}.html`;
                      assertCurrent(isActive);
                      const downloaded = await FileSystem.downloadAsync(
                        app.client.caseExportUrl(proofId, packet.caseId),
                        uri,
                        { headers: app.client.authorizedDownloadHeaders() },
                      );
                      if (!isActive()) { await FileSystem.deleteAsync(uri, { idempotent: true }); assertCurrent(isActive); }
                      if (downloaded.status !== 200) {
                        await FileSystem.deleteAsync(uri, { idempotent: true });
                        throw new Error(
                          "The approved export could not be downloaded. Refresh and retry.",
                        );
                      }
                      const Sharing = await import("expo-sharing").catch(() => {
                        throw new Error(
                          "Update PackProof to share file exports, or download this approved packet from the web workspace.",
                        );
                      });
                      if (!(await Sharing.isAvailableAsync()))
                        throw new Error(
                          "File sharing is unavailable on this device. Open the web workspace to download this approved packet.",
                        );
                      assertCurrent(isActive);
                      await Sharing.shareAsync(uri, {
                        mimeType: "text/html",
                        dialogTitle:
                          "Choose where to save or share the approved case packet",
                      });
                    })
                  }
                />
                <RecipientExportPanel key={packet.caseId} api={app.client} userId={app.session.userId} proofId={proofId} caseId={packet.caseId} sources={Array.isArray(packet.preview.evidence) ? packet.preview.evidence.filter((value): value is { evidenceId: string; contentType: string } => !!value && typeof value === 'object' && typeof value.evidenceId === 'string' && typeof value.contentType === 'string') : []} isCurrent={isCurrent} ensureAuth={app.ensureAuth} />
              </View>
            ) : null}
          </> : null}
          {tool === 'history' && app.proof ? <ItemHistoryPanel api={app.client} proof={app.proof} userId={app.session.userId} history={record.history} enabled={record.capabilities?.history !== false} reload={reload} openProof={app.openProof} ensureAuth={app.ensureAuth} isCurrent={isCurrent} incomingShareId={app.route.historyShareId} /> : null}
          {tool === "compare" ? <>
          <InfoCard>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: 20,
                fontWeight: "600",
              }}
            >
              Compare recordings
            </Text>
            <Text style={{ color: colors.textSecondary }}>
              Select both originals to inspect. Different light, glare, or
              angles may prevent comparison. A matching identifier does not
              authenticate an item.
            </Text>
            {videos
              .filter((video) => !video.stageId)
              .map((video) => (
                <Button
                  key={video.evidenceId}
                  label={`Use outbound ${video.evidenceId.slice(-8)}`}
                  variant="secondary"
                  onPress={() => setLeft(video)}
                />
              ))}
            {videos
              .filter((video) => video.stageId)
              .map((video) => (
                <Button
                  key={video.evidenceId}
                  label={`Use receipt / return ${video.evidenceId.slice(-8)}`}
                  variant="secondary"
                  onPress={() => setRight(video)}
                />
              ))}
            {left && right ? (
              <>
                <Text style={{ color: colors.textPrimary }}>
                  Select an outbound moment
                </Text>
                {record.snapshot.data.anchors
                  .filter((anchor) => anchor.evidenceId === left.evidenceId)
                  .map((anchor) => (
                    <Button
                      key={anchor.anchorId}
                      label={`${outboundAnchor?.anchorId === anchor.anchorId ? "Selected · " : ""}${anchor.label} · ${elapsedLabel(anchor.startMs)}`}
                      variant="secondary"
                      onPress={() => setOutboundAnchor(anchor)}
                    />
                  ))}
                <Text style={{ color: colors.textPrimary }}>
                  Select an incoming moment
                </Text>
                {record.snapshot.data.anchors
                  .filter((anchor) => anchor.evidenceId === right.evidenceId)
                  .map((anchor) => (
                    <Button
                      key={anchor.anchorId}
                      label={`${inboundAnchor?.anchorId === anchor.anchorId ? "Selected · " : ""}${anchor.label} · ${elapsedLabel(anchor.startMs)}`}
                      variant="secondary"
                      onPress={() => setInboundAnchor(anchor)}
                    />
                  ))}
                <Button label="Manage recording bookmarks" variant="tertiary" onPress={() => selectTool("replay")} />
                {outboundAnchor?.evidenceId === left.evidenceId &&
                inboundAnchor?.evidenceId === right.evidenceId ? (
                  <>
                    <PairedReturnPlayer
                      outboundUri={mediaUri(app.client, proofId, left)}
                      incomingUri={mediaUri(app.client, proofId, right)}
                      token={app.session.token}
                      outbound={outboundAnchor}
                      incoming={inboundAnchor}
                    />
                    <FormField
                      label="Describe what you can or cannot compare"
                      value={comparisonNotes}
                      onChangeText={setComparisonNotes}
                      multiline
                    />
                    {[
                      ["NOT_COMPARABLE", "Not comparable"],
                      ["OBSERVED_DIFFERENCE", "I observe a visible difference"],
                      [
                        "NO_VISIBLE_DIFFERENCE",
                        "I observe no visible difference",
                      ],
                    ].map(([value, title]) => (
                      <Button
                        key={value}
                        label={`${comparisonState === value ? "Selected · " : ""}${title}`}
                        variant="secondary"
                        onPress={() => setComparisonState(value)}
                      />
                    ))}
                    <Button
                      label={
                        correcting
                          ? "Append corrected observation"
                          : "Save my paired observation"
                      }
                      disabled={
                        busy ||
                        !comparisonNotes.trim() ||
                        record.capabilities?.compare === false
                      }
                      onPress={() =>
                        void run(async () => {
                          await request("/comparisons", "POST", {
                            snapshotId: record.snapshot.snapshotId,
                            outboundAnchorId: outboundAnchor.anchorId,
                            inboundAnchorId: inboundAnchor.anchorId,
                            state: comparisonState,
                            note: comparisonNotes.trim(),
                            ...(correcting ? { supersedesId: correcting } : {}),
                          });
                          setComparisonNotes("");
                          setCorrecting(null);
                          await reload();
                        })
                      }
                    />
                  </>
                ) : null}
              </>
            ) : (
              <Text style={{ color: colors.textSecondary }}>
                A committed outbound and incoming recording are needed for
                paired inspection.
              </Text>
            )}
            {record.comparisons.map((comparison) => (
              <View key={comparison.comparisonId} style={{ gap: 8 }}>
                <Text style={{ color: colors.textPrimary }}>
                  {comparison.state.replaceAll("_", " ")} · user-marked
                  observation
                </Text>
                <Text style={{ color: colors.textSecondary }}>
                  {comparison.note}
                </Text>
                <Button
                  label="Inspect both source moments"
                  variant="secondary"
                  onPress={() => {
                    setLeft(
                      videos.find(
                        (video) =>
                          video.evidenceId === comparison.outbound.evidenceId,
                      ) ?? null,
                    );
                    setRight(
                      videos.find(
                        (video) =>
                          video.evidenceId === comparison.inbound.evidenceId,
                      ) ?? null,
                    );
                    setOutboundAnchor(comparison.outbound);
                    setInboundAnchor(comparison.inbound);
                  }}
                />
                {comparison.authorUserId === app.session!.userId ? (
                  <Button
                    label="Append a correction"
                    variant="tertiary"
                    onPress={() => {
                      setCorrecting(comparison.comparisonId);
                      setComparisonNotes(comparison.note);
                      setComparisonState(comparison.state);
                      setLeft(
                        videos.find(
                          (video) =>
                            video.evidenceId === comparison.outbound.evidenceId,
                        ) ?? null,
                      );
                      setRight(
                        videos.find(
                          (video) =>
                            video.evidenceId === comparison.inbound.evidenceId,
                        ) ?? null,
                      );
                      setOutboundAnchor(comparison.outbound);
                      setInboundAnchor(comparison.inbound);
                    }}
                  />
                ) : null}
              </View>
            ))}
            {app.proof?.status === "FINALIZED" ? <Button
              label="Document receipt or return"
              variant="secondary"
              onPress={() => app.openReceipt(proofId)}
            /> : null}
          </InfoCard>
          </> : null}
        </>
      ) : !busy && !error ? <Text style={{ color: colors.textSecondary }}>No evidence is available yet.</Text> : null}
      </RestoringScrollView>
      </FadeSlideIn>
    </AppScreen>
  );
}
