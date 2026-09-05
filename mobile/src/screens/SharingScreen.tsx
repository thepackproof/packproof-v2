import { useEffect, useRef, useState } from "react";
import { Image, Linking, Share, Switch, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { InfoCard } from "../ui/ProofCard";
import { RecordedVideo } from "../ui/RecordedVideo";
import type { AccessLinkView } from "../v2-api";
type Derivative = {
  derivativeId: string;
  evidenceId: string;
  status: string;
  contentType: string;
  sha256: string;
};
type Preview = {
  status: string;
  tracker: {
    itemTitle: string | null;
    headline: string;
    milestones: Array<{
      code: string;
      label: string;
      occurredAt: string | null;
    }>;
  };
  evidence: Array<{
    evidenceId: string;
    derivativeId?: string;
    label: string;
    contentType: string;
  }>;
  disclosure: { viewHash: string; revocationNotice: string; fields: string[] };
  receipt: {
    carrierReportedDelivered: boolean;
    buyerReportedReceived: boolean;
    message: string;
  };
};
export function SharingScreen() {
  const app = usePackProof(),
    { colors } = useTheme(),
    proofId = app.proof?.proofId;
  const [fields, setFields] = useState(["status", "order", "shipping"]),
    [purpose, setPurpose] = useState("BUYER_RECEIPT");
  const [derivatives, setDerivatives] = useState<Derivative[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null),
    [link, setLink] = useState<AccessLinkView | null>(null),
    [links, setLinks] = useState<AccessLinkView[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [days, setDays] = useState(7);
  const lock = useRef(false);
  const request = <T,>(path: string, method = "GET", body?: unknown) =>
    app.client.disclosureRequest<T>(proofId!, path, method, body);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await app.ensureAuth();
      await fn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Sharing is unavailable. No new link was confirmed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const invalidate = () => {
    setPreview(null);
    setLink(null);
  };
  const scope = () => ({
    purpose,
    fields: selected.length ? [...fields, "evidence"] : fields,
    media: derivatives
      .filter((item) => selected.includes(item.derivativeId))
      .map((item) => ({
        evidenceId: item.evidenceId,
        representation: "DERIVATIVE",
        derivativeId: item.derivativeId,
      })),
  });
  const reload = async () => {
    setLinks((await app.client.listAccessLinks(proofId!)).accessLinks);
    setDerivatives(
      (
        await request<{ derivatives: Derivative[] }>("/redactions")
      ).derivatives.filter((item) => item.status === "REVIEWED"),
    );
  };
  useEffect(() => {
    if (proofId) void run(reload);
  }, [proofId]);
  if (!proofId || !app.session)
    return (
      <AppScreen>
        <AppHeader title="Sharing" onBack={app.goBack} />
      </AppScreen>
    );
  return (
    <AppScreen>
      <AppHeader title="Preview as recipient" onBack={app.goBack} />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      ) : null}
      <Text style={{ color: colors.textSecondary }}>
        Choose what this recipient can see. Addresses, payment details, and
        unreviewed original media are excluded from this mobile sharing flow.
      </Text>
      {[
        ["BUYER_RECEIPT", "Buyer receipt"],
        ["CLAIMS_REVIEW", "Claims review"],
      ].map(([value, title]) => (
        <Button
          key={value}
          label={`${purpose === value ? "Selected · " : ""}${title}`}
          variant="secondary"
          disabled={busy}
          onPress={() => {
            setPurpose(value);
            invalidate();
          }}
        />
      ))}
      {[
        ["status", "Proof status (always included)"],
        ["order", "Item title"],
        ["shipping", "Carrier-reported shipment state"],
      ].map(([field, title]) => (
        <View
          key={field}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text style={{ color: colors.textPrimary, flex: 1 }}>{title}</Text>
          <Switch
            disabled={busy || field === "status"}
            accessibilityLabel={`Include ${title}`}
            value={fields.includes(field)}
            onValueChange={(include) => {
              setFields((current) =>
                include
                  ? [...current, field]
                  : current.filter((item) => item !== field),
              );
              invalidate();
            }}
          />
        </View>
      ))}
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
        Reviewed redacted recordings
      </Text>
      {!derivatives.length ? (
        <Text style={{ color: colors.textSecondary }}>
          No reviewed redacted media is available. You can share selected record
          details now, or prepare media using the web privacy controls.
        </Text>
      ) : null}
      {derivatives.map((item) => (
        <View key={item.derivativeId} style={{ gap: 8 }}>
          <Button
            label={`${selected.includes(item.derivativeId) ? "Exclude" : "Include"} redacted copy ${item.derivativeId.slice(-8)}`}
            variant="secondary"
            disabled={busy}
            onPress={() => {
              setSelected((current) =>
                current.includes(item.derivativeId)
                  ? current.filter((id) => id !== item.derivativeId)
                  : [
                      ...current.filter(
                        (id) =>
                          !derivatives.some(
                            (other) =>
                              other.derivativeId === id &&
                              other.evidenceId === item.evidenceId,
                          ),
                      ),
                      item.derivativeId,
                    ],
              );
              invalidate();
            }}
          />
          {selected.includes(item.derivativeId) &&
          item.contentType?.startsWith("image/") ? (
            <Image
              source={{
                uri: app.client.redactionReviewUrl(proofId, item.derivativeId),
                headers: app.client.authorizedDownloadHeaders(),
              }}
              style={{ width: "100%", height: 220 }}
              resizeMode="contain"
              accessibilityLabel="Selected reviewed redacted image"
            />
          ) : null}
          {selected.includes(item.derivativeId) &&
          item.contentType?.startsWith("video/") ? (
            <RecordedVideo
              uri={app.client.redactionReviewUrl(proofId, item.derivativeId)}
              token={app.session!.token}
            />
          ) : null}
        </View>
      ))}
      <Button
        label="Open full media privacy controls"
        variant="secondary"
        onPress={() =>
          void Linking.openURL(
            `https://thepackproof.com/proofs/${encodeURIComponent(proofId)}#sharing`,
          )
        }
      />
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
        Link expiry
      </Text>
      {[1, 7, 30].map((value) => (
        <Button
          key={value}
          label={`${days === value ? "Selected · " : ""}${value} ${value === 1 ? "day" : "days"}`}
          variant="secondary"
          disabled={busy}
          onPress={() => {
            setDays(value);
            invalidate();
          }}
        />
      ))}
      <Button
        label="Preview selected disclosure"
        loading={busy}
        onPress={() =>
          void run(async () => {
            setLink(null);
            setPreview(await request<Preview>("/preview", "POST", scope()));
          })
        }
      />
      {preview ? (
        <InfoCard>
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: 20,
              fontWeight: "600",
            }}
          >
            Recipient view
          </Text>
          {preview.disclosure.fields.includes("status") ? (
            <Text style={{ color: colors.textPrimary }}>
              Proof status: {preview.status}
            </Text>
          ) : null}
          {preview.disclosure.fields.includes("order") ? (
            <Text style={{ color: colors.textPrimary }}>
              {preview.tracker.itemTitle || "Item title not supplied"}
            </Text>
          ) : null}
          {preview.disclosure.fields.includes("shipping") ? (
            <>
              <Text style={{ color: colors.textPrimary }}>
                {preview.tracker.headline}
              </Text>
              {preview.tracker.milestones.map((item) => (
                <Text key={item.code} style={{ color: colors.textSecondary }}>
                  {item.label}
                  {item.occurredAt
                    ? ` · ${new Date(item.occurredAt).toLocaleString()}`
                    : ""}
                </Text>
              ))}
            </>
          ) : null}
          {preview.evidence.map((item) => (
            <Text key={item.evidenceId} style={{ color: colors.textSecondary }}>
              {item.label} · {item.contentType}
            </Text>
          ))}
          <Text style={{ color: colors.textSecondary }}>
            Buyer report:{" "}
            {preview.receipt.buyerReportedReceived
              ? "Receipt documented by buyer"
              : "No buyer receipt report"}
            . {preview.receipt.message}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {preview.disclosure.revocationNotice}
          </Text>
          {!link ? (
            <Button
              label="Approve preview and create link"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  setLink(
                    await request<AccessLinkView>("/grants", "POST", {
                      ...scope(),
                      previewHash: preview.disclosure.viewHash,
                      expiresAt: new Date(
                        Date.now() + days * 86400000,
                      ).toISOString(),
                    }),
                  );
                  await reload();
                })
              }
            />
          ) : (
            <Button
              label="Choose where to share this link"
              onPress={() => {
                if (link.url)
                  void Share.share({
                    message: `View this PackProof: ${link.url}`,
                    url: link.url,
                  });
              }}
            />
          )}
        </InfoCard>
      ) : null}
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
        Existing links
      </Text>
      {links
        .filter((item) => !item.revokedAt)
        .map((item) => (
          <View key={item.accessLinkId} style={{ gap: 8 }}>
            <Text style={{ color: colors.textSecondary }}>
              Viewing link ·{" "}
              {item.expiresAt
                ? `expires ${new Date(item.expiresAt).toLocaleDateString()}`
                : "no scheduled expiry"}
            </Text>
            <Button
              label="Revoke this link"
              variant="destructive"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await app.client.revokeAccessLink(proofId, item.accessLinkId);
                  if (link?.accessLinkId === item.accessLinkId) setLink(null);
                  await reload();
                })
              }
            />
          </View>
        ))}
    </AppScreen>
  );
}
