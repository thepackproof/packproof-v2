import { useEffect, useState } from "react";
import type { SourceRole, WorkspaceBridge, WorkspaceFolderSuggestion } from "../workspace-types";
import { Row, shortFolder } from "./SetupParts";

const folderHint: Record<WorkspaceFolderSuggestion["kind"], string> = {
  discovered: "Matched export",
  prepared: "PackProof’s export folder on this computer",
  selected: "Previously selected on this computer",
};

interface Props {
  role: SourceRole;
  bridge: WorkspaceBridge;
  busy: boolean;
  onChoose: (folder: string) => void;
}

export function FolderSuggestions({ role, bridge, busy, onChoose }: Props) {
  const [folders, setFolders] = useState<WorkspaceFolderSuggestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);

  useEffect(() => {
    let active = true;
    setFolders(null);
    setFailed(false);
    async function scan() {
      if (bridge.discoverWorkspaceFolders) return bridge.discoverWorkspaceFolders(role);
      const previous = await bridge.getWorkspaceFolderSuggestion?.(role);
      return previous ? [previous] : [];
    }
    void scan().then(
      (result) => {
        if (active) setFolders(result);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [role, bridge, attempt]);

  if (failed) {
    return (
      <div className="setup-error" role="alert">
        PackProof couldn’t finish checking the usual export locations.{" "}
        <button className="setup-link" disabled={busy} onClick={() => retry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!folders) return <p role="status">Looking in common export folders…</p>;

  const matches = folders.filter((item) => item.kind === "discovered");
  const existing = folders.filter((item) => item.kind !== "discovered");
  function option(item: WorkspaceFolderSuggestion) {
    const label = item.label || shortFolder(item.folder);
    const detail = item.evidence || folderHint[item.kind];
    return (
      <Row
        key={item.folder}
        icon="folder"
        title={label}
        detail={`${detail} · ${item.folder}`}
        onClick={bridge.useWorkspaceFolderSuggestion ? () => onChoose(item.folder) : undefined}
        disabled={busy}
      />
    );
  }
  return (
    <>
      {matches.length ? (
        <div className="setup-choice-list" role="group" aria-label="Matching exports">
          <h3>Matching exports</h3>
          {matches.map(option)}
        </div>
      ) : bridge.discoverWorkspaceFolders ? (
        <p role="status">PackProof didn’t recognize a matching export in the folders it checked.</p>
      ) : !existing.length ? (
        <p role="status">There’s no suggested folder on this computer.</p>
      ) : null}
      {existing.length > 0 && (
        <div className="setup-choice-list" role="group" aria-label="Other available folders">
          <h3>Other available folders</h3>
          {existing.map(option)}
        </div>
      )}
      {bridge.discoverWorkspaceFolders && (
        <button className="setup-link" disabled={busy} onClick={() => retry((n) => n + 1)}>
          Search again
        </button>
      )}
    </>
  );
}
