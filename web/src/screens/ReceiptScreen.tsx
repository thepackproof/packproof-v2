import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { CanonicalProof, PublicProfileView } from "../api/types";
import { PageHeader } from "../components/PageHeader";

type Stage = {
  stageId: string;
  type: string;
  finalizedAt: string | null;
  sha256: string | null;
  evidence: Array<{ evidenceId: string; committedAt: string | null }>;
};
type Lifecycle = {
  proof: CanonicalProof;
  role: "SELLER" | "BUYER";
  stages: Stage[];
};
const STAGES = [
  {
    type: "RECEIPT",
    label: "Receive and inspect",
    role: "BUYER",
    statement: "I_RECORDED_RECEIPT",
    attest: "I recorded the package and item as I received them.",
  },
  {
    type: "RETURN_PACKING",
    label: "Pack a return",
    role: "BUYER",
    statement: "I_PACKED_RETURN",
    attest: "I recorded the item being packed and sealed for return.",
  },
  {
    type: "RETURN_RECEIPT",
    label: "Receive the return",
    role: "SELLER",
    statement: "I_RECEIVED_RETURN",
    attest: "I recorded the returned package and item as I received them.",
  },
];
export function ReceiptScreen({
  api,
  proofId,
  onBack,
}: {
  api: PackProofApi;
  proofId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<Lifecycle | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [users, setUsers] = useState<PublicProfileView[]>([]),
    [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null),
    [attested, setAttested] = useState(false);
  const [upload, setUpload] = useState<{
    stageId: string;
    evidenceId: string;
    target: Parameters<PackProofApi["uploadObject"]>[0];
  } | null>(null);
  const refresh = async () => {
    setData(await api.lifecycleRequest<Lifecycle>(proofId, ""));
  };
  useEffect(() => {
    setData(null);
    setError(null);
    void refresh().catch((e) => setError(e.message));
  }, [proofId, api]);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  const next = STAGES.find(
    (s) => !data?.stages.some((done) => done.type === s.type && done.finalizedAt),
  );
  const active = data?.stages.find((s) => s.type === next?.type);
  const committed = Boolean(active?.evidence.length && active.evidence.every((e) => e.committedAt));
  return (
    <main className="page stack">
      <PageHeader title="Receipt and returns" onBack={onBack} />
      {error ? (
        <p role="alert" className="banner banner-error">
          {error}
        </p>
      ) : null}
      {!data ? (
        <section className="section stack">
          <p>Sign in as the invited receiver to join this record.</p>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api.lifecycleRequest(proofId, "/accept", "POST", {});
                await refresh();
              })
            }
          >
            Accept receipt invitation
          </button>
        </section>
      ) : (
        <>
          <section className="section stack">
            <h2>{data.proof.transaction.itemTitle ?? "Shipment"}</h2>
            <p className="note">
              The seller’s finalized Proof is preserved. Receipt and return records are added with
              their own linked manifests.
            </p>
          </section>
          {data.role === "SELLER" ? (
            <section className="section stack">
              <h2>Invite the receiver</h2>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => setUsers((await api.searchUsers(query)).users));
                }}
              >
                <label className="field">
                  <span>PackProof username</span>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <button className="btn btn-secondary" disabled={busy || query.trim().length < 3}>
                  Find receiver
                </button>
              </form>
              {users.map((user) => (
                <button
                  className="option-card"
                  key={user.userId}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api.lifecycleRequest(proofId, "/receiver", "POST", {
                        userId: user.userId,
                      });
                      setNotice(
                        `Invitation ready for ${user.displayName || user.username}. Share this link: ${window.location.origin}/receipt/${proofId}`,
                      );
                      setUsers([]);
                    })
                  }
                >
                  {user.displayName || user.username} · Invite
                </button>
              ))}
              {notice ? (
                <p role="status" className="secret-value">
                  {notice}
                </p>
              ) : null}
            </section>
          ) : null}
          <section className="section stack">
            <h2>Shipment lifecycle</h2>
            {STAGES.map((stage) => {
              const saved = data.stages.find((s) => s.type === stage.type);
              return (
                <article className="info-card" key={stage.type}>
                  <strong>{stage.label}</strong>
                  <p className="meta">
                    {saved?.finalizedAt
                      ? `Preserved ${new Date(saved.finalizedAt).toLocaleString()}`
                      : saved
                        ? "Recording in progress"
                        : "Not yet recorded"}
                  </p>
                  {saved?.sha256 ? (
                    <details>
                      <summary>Stage SHA-256</summary>
                      <code className="secret-value">{saved.sha256}</code>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </section>
          {next && next.role === data.role ? (
            <section className="section stack">
              <h2>{next.label}</h2>
              <p className="note">
                Show the unopened package, label, opening, and item condition. For a return, show
                the item being packed and sealed.
              </p>
              {active?.evidence.some((e) => !e.committedAt) ? (
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      for (const media of active.evidence.filter((e) => !e.committedAt))
                        await api.lifecycleRequest(
                          proofId,
                          `/stages/${active.stageId}/evidence/${media.evidenceId}/discard`,
                          "POST",
                          {},
                        );
                      setUpload(null);
                      setFile(null);
                      await refresh();
                    })
                  }
                >
                  Discard unfinished upload and record again
                </button>
              ) : null}
              {!committed ? (
                <>
                  <label className="field">
                    <span>Stage recording</span>
                    <input
                      type="file"
                      accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png"
                      capture="environment"
                      disabled={busy || Boolean(upload)}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={busy || !file}
                    onClick={() =>
                      void action(async () => {
                        const stage =
                          active ??
                          (await api.lifecycleRequest<{ stageId: string }>(
                            proofId,
                            "/stages",
                            "POST",
                            { type: next.type },
                          ));
                        let target = upload;
                        if (!target) {
                          const initialized = await api.lifecycleRequest<{
                            evidenceId: string;
                            upload: Parameters<PackProofApi["uploadObject"]>[0];
                          }>(proofId, `/stages/${stage.stageId}/evidence`, "POST", {
                            contentType: file!.type,
                            idempotencyKey: crypto.randomUUID(),
                          });
                          target = {
                            stageId: stage.stageId,
                            evidenceId: initialized.evidenceId,
                            target: initialized.upload,
                          };
                          setUpload(target);
                        }
                        await api.uploadObject(target.target, file!, file!.type);
                        await api.lifecycleRequest(
                          proofId,
                          `/stages/${target.stageId}/evidence/${target.evidenceId}/commit`,
                          "POST",
                          {},
                        );
                        setFile(null);
                        setUpload(null);
                        await refresh();
                      })
                    }
                  >
                    {busy ? "Preserving…" : upload ? "Retry upload" : "Use stage recording"}
                  </button>
                </>
              ) : null}
              {committed ? (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={attested}
                      onChange={(e) => setAttested(e.target.checked)}
                    />{" "}
                    {next.attest}
                  </label>
                  <button
                    className="btn"
                    disabled={!attested || busy}
                    onClick={() =>
                      void action(async () => {
                        await api.lifecycleRequest(
                          proofId,
                          `/stages/${active!.stageId}/finalize`,
                          "POST",
                          { statement: next.statement },
                        );
                        setAttested(false);
                        await refresh();
                      })
                    }
                  >
                    Finalize this stage
                  </button>
                </>
              ) : null}
            </section>
          ) : next ? (
            <p className="note">
              Waiting for the {next.role === "BUYER" ? "receiver" : "seller"} to document the next
              stage.
            </p>
          ) : (
            <p className="integrity-mark">Receipt and return stages preserved.</p>
          )}
        </>
      )}
    </main>
  );
}
