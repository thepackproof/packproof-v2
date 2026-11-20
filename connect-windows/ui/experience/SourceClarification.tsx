import type { ConnectStatus } from "../types";
import type { WorkspaceBridge, WorkspaceSource } from "../workspace-types";
export function Clarify({
  source,
  bridge,
  apply,
  busy,
}: {
  source: WorkspaceSource;
  bridge: WorkspaceBridge;
  apply: (f: () => Promise<ConnectStatus>) => void;
  busy: boolean;
}) {
  const r = source.recognition;
  if (r.state !== "ambiguous") return null;
  const choice = r.relatedChoices?.[0];
  if (choice)
    return (
      <fieldset className="setup-clarify">
        <legend>{r.question || "Which source supplies this reference?"}</legend>
        {choice.options.map((o) => (
          <button
            key={o.id}
            className="setup-secondary"
            disabled={busy}
            onClick={() =>
              apply(() =>
                bridge.chooseWorkspaceRelatedSource(source.id, source.generation, choice.role, o.id),
              )
            }
          >
            {o.displayName}
          </button>
        ))}
      </fieldset>
    );
  if (!r.question || !r.profileVersion) return null;
  return (
    <div className="setup-clarify">
      <p>{r.question}</p>
      {r.suggestedOrderColumn && r.sample?.[r.suggestedOrderColumn] && (
        <p>Example · {r.sample[r.suggestedOrderColumn]}</p>
      )}
      <button
        className="setup-secondary"
        disabled={busy}
        onClick={() =>
          apply(() => bridge.confirmWorkspaceOrderMap(source.id, source.generation, r.profileVersion!))
        }
      >
        Confirm this reference
      </button>
    </div>
  );
}
