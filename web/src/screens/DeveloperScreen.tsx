import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
import { PageHeader } from "../components/PageHeader";

type Tenant = { id: string; name: string; environment: string };
type Key = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  revokedAt: string | null;
};
export function DeveloperScreen({ api, onBack }: { api: PackProofApi; onBack: () => void }) {
  const [tenants, setTenants] = useState<Tenant[]>([]),
    [tenantId, setTenantId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>(["proofs:read"]);
  const [keys, setKeys] = useState<Key[]>([]),
    [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    const list = await api.developerRequest<{
      tenants: Tenant[];
      availableScopes: string[];
    }>("");
    setTenants(list.tenants);
    setScopes(list.availableScopes);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [api]);
  useEffect(() => {
    setToken(null);
    setKeys([]);
    if (tenantId)
      void api
        .developerRequest<{ keys: Key[] }>(`/${tenantId}/keys`)
        .then((v) => setKeys(v.keys))
        .catch((e) => setError(e.message));
  }, [tenantId, api]);
  async function action(run: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  async function reloadKeys() {
    setKeys((await api.developerRequest<{ keys: Key[] }>(`/${tenantId}/keys`)).keys);
  }
  return (
    <main className="page stack">
      <PageHeader title="Developer access" onBack={onBack} />
      <p className="lede">Connect your order system to the same PackProof record.</p>
      {error ? (
        <div role="alert" className="banner banner-error">
          {error}
        </div>
      ) : null}
      <section className="section stack">
        <h2>Workspaces</h2>
        <label className="field">
          <span>Workspace</span>
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="">Choose a workspace</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.environment}
              </option>
            ))}
          </select>
        </label>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const t = await api.developerRequest<Tenant>("", "POST", {
                name,
                environment: "sandbox",
              });
              await refresh();
              setTenantId(t.id);
              setName("");
            });
          }}
        >
          <label className="field">
            <span>New sandbox name</span>
            <input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn btn-secondary" disabled={busy || !name.trim()}>
            Create sandbox
          </button>
        </form>
        <p className="note">
          Sandbox orders stay separate from live integrations. Use test orders and test media.
        </p>
      </section>
      {tenantId ? (
        <section className="section stack">
          <h2>API keys</h2>
          <p className="note">
            Choose only the permissions this integration needs. Keys belong on your server.
          </p>
          <fieldset className="scope-grid">
            <legend>Permissions</legend>
            {scopes.map((s) => (
              <label key={s}>
                <input
                  type="checkbox"
                  checked={selected.includes(s)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, s] : selected.filter((v) => v !== s),
                    )
                  }
                />
                {s}
              </label>
            ))}
          </fieldset>
          <button
            className="btn"
            disabled={busy || !selected.length}
            onClick={() =>
              void action(async () => {
                const result = await api.developerRequest<{ token: string }>(
                  `/${tenantId}/keys`,
                  "POST",
                  { name: "Integration key", scopes: selected },
                );
                setToken(result.token);
                await reloadKeys();
              })
            }
          >
            Create API key
          </button>
          {token ? (
            <div className="banner stack">
              <strong>Save this key now</strong>
              <p className="note">
                It is shown only here. This page does not save it in browser storage.
              </p>
              <code className="secret-value">{token}</code>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setToken(null);
                }}
              >
                Hide key
              </button>
            </div>
          ) : null}
          {keys.map((key) => (
            <article className="info-card stack" key={key.id}>
              <strong>{key.name}</strong>
              <span className="meta">
                {key.prefix}… · {key.revokedAt ? "Revoked" : "Active"}
              </span>
              <span className="meta">{key.scopes.join(", ")}</span>
              {!key.revokedAt ? (
                <div className="btn-row">
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const r = await api.developerRequest<{ token: string }>(
                          `/${tenantId}/keys/${key.id}/rotate`,
                          "POST",
                          {},
                        );
                        setToken(r.token);
                        await reloadKeys();
                      })
                    }
                  >
                    Rotate key
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api.developerRequest(`/${tenantId}/keys/${key.id}`, "DELETE");
                        await reloadKeys();
                      })
                    }
                  >
                    Revoke key
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      <section className="section stack">
        <h2>First request</h2>
        <p>
          Create a tenant-bound order with an idempotency key. Capture and viewing links require the
          merchant’s PackProof sign-in.
        </p>
        <pre>
          {
            'POST /v1/proofs\nAuthorization: Bearer YOUR_API_KEY\nIdempotency-Key: order-123\nContent-Type: application/json\n\n{"externalId":"123","transaction":{"itemTitle":"Trading card"}}'
          }
        </pre>
        <a
          href="https://github.com/thepackproof/packproof-v2/blob/main/docs/PUBLIC_API.md"
          target="_blank"
          rel="noreferrer"
        >
          API documentation
        </a>
      </section>
    </main>
  );
}
