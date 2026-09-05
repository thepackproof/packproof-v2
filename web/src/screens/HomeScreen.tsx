import { useMemo, useState } from "react";
import {
  filterProofLibrary,
  invitationCardModel,
  toProofCardModel,
  uniqueCarriers,
  type ProofLibrarySort,
  type ProofLibraryView,
  type ProofRoleFilter,
} from "@packproof/copy/presentation";
import type { InvitationInboxView, ProofCollectionItem } from "../api/types";
import { CreateFab } from "../components/CreateFab";
import { IconCheck, IconFilter, IconSearch, IconTime } from "../components/Icons";
import { ProofCard } from "../components/ProofCard";
import { SegmentedTabs } from "../components/SegmentedTabs";

export function HomeScreen(props: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  loading: boolean;
  error: string | null;
  onOpenProof: (proofId: string) => void;
  onCreate: () => void;
  onOpenInvitation: (invite: InvitationInboxView) => void;
}) {
  const [view, setView] = useState<ProofLibraryView>("in_progress");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProofLibrarySort>("newest");
  const [role, setRole] = useState<ProofRoleFilter>("all");
  const [carrier, setCarrier] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const carriers = useMemo(() => uniqueCarriers(props.proofs), [props.proofs]);
  const proofs = useMemo(
    () => filterProofLibrary(props.proofs, { view, query, sort, role, carrier }),
    [props.proofs, view, query, sort, role, carrier],
  );
  const invitations =
    view === "in_progress" && role === "all" && !carrier
      ? props.invitations.filter((invite) => {
          const needle = query.trim().toLowerCase();
          if (!needle) {
            return true;
          }
          return [invite.transaction.itemTitle, invite.inviter.displayName, invite.inviter.username]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle);
        })
      : [];
  const empty = !props.loading && proofs.length === 0 && invitations.length === 0;

  return (
    <main className="page library-page">
      <h1 className="page-title">My Proofs</h1>
      {!props.loading && !props.proofs.length && !props.invitations.length ? (
        <section className="section stack">
          <h2>Protect your shipment with a PackProof.</h2>
          <p>Add your order, record the packing and seal, then preserve the record.</p>
          <p className="kicker">Order → Record → Seal → Proof</p>
          <button className="btn" onClick={props.onCreate}>
            Create your first Proof
          </button>
        </section>
      ) : null}
      <SegmentedTabs
        label="Proof library"
        selected={view}
        onSelect={setView}
        options={[
          { id: "in_progress", label: "In Progress", icon: <IconTime /> },
          { id: "completed", label: "Completed", icon: <IconCheck /> },
        ]}
      />
      <div className="search-row">
        <label className="search-field">
          <IconSearch />
          <span className="visually-hidden">Search proofs</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search proofs..."
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="filter-btn"
          aria-label="Filter and sort"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <IconFilter />
        </button>
      </div>
      {filterOpen ? (
        <section className="filter-sheet" aria-label="Sort and filter">
          <p className="filter-label">Sort</p>
          <ChipRow
            options={[
              { id: "newest", label: "Newest first" },
              { id: "oldest", label: "Oldest first" },
              { id: "price_high", label: "Price high to low" },
              { id: "price_low", label: "Price low to high" },
            ]}
            selected={sort}
            onSelect={setSort}
          />
          <p className="filter-label">Role</p>
          <ChipRow
            options={[
              { id: "all", label: "All" },
              { id: "seller", label: "Seller" },
              { id: "buyer", label: "Buyer" },
            ]}
            selected={role}
            onSelect={setRole}
          />
          {carriers.length > 0 ? (
            <>
              <p className="filter-label">Carrier</p>
              <ChipRow
                options={[
                  { id: "", label: "All" },
                  ...carriers.map((item) => ({ id: item, label: item })),
                ]}
                selected={carrier ?? ""}
                onSelect={(value) => setCarrier(value || null)}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      {props.loading && proofs.length === 0 && invitations.length === 0 ? (
        <p className="empty">Loading PackProofs…</p>
      ) : null}

      <div className="card-list">
        {invitations.map((invite) => (
          <ProofCard
            key={invite.invitationId}
            model={invitationCardModel(invite)}
            onPress={() => props.onOpenInvitation(invite)}
          />
        ))}
        {proofs.map((item) => (
          <ProofCard
            key={item.proofId}
            model={toProofCardModel(item)}
            onPress={() => props.onOpenProof(item.proofId)}
          />
        ))}
      </div>

      {empty ? (
        <div className="empty-card empty-state">
          <p className="card-title">
            {view === "completed" ? "No completed Proofs" : "No Proofs in progress"}
          </p>
          <p>
            {view === "completed"
              ? "Finalized Proofs will appear here."
              : "Create a Proof to start a record, or review an invitation."}
          </p>
          {view === "in_progress" ? (
            <button className="btn" type="button" onClick={props.onCreate}>
              Create a Proof
            </button>
          ) : null}
          <p className="visually-hidden">No Proofs to show yet.</p>
        </div>
      ) : null}

      <CreateFab onPress={props.onCreate} />
    </main>
  );
}

function ChipRow<T extends string>(props: {
  options: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="chip-row">
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="chip"
          aria-pressed={props.selected === option.id}
          onClick={() => props.onSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
