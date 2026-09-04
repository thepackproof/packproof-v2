import { useMemo, useState } from "react";
import {
  filterProofLibrary,
  filterProofInvitations,
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
  onRetry?: () => void;
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
  const invitations = filterProofInvitations(props.invitations, { view, role, carrier, query });
  const filtered = Boolean(query.trim() || role !== "all" || carrier);
  const clearFilters = () => { setQuery(""); setRole("all"); setCarrier(null); };
  const empty = !props.loading && proofs.length === 0 && invitations.length === 0;

  return (
    <main className="page library-page">
      <div className="library-heading">
        <h1 className="page-title">My Proofs</h1>
        <p className="meta">Your evidence, connected to every order.</p>
      </div>
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
          {filtered ? <span className="filter-indicator" aria-label="Filters active" /> : null}
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
                options={[{ id: "", label: "All" }, ...carriers.map((item) => ({ id: item, label: item }))]}
                selected={carrier ?? ""}
                onSelect={(value) => setCarrier(value || null)}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {props.error ? (
        <div className="banner banner-error" role="alert">
          <p>{props.error}</p>
          {props.onRetry ? <button type="button" className="btn btn-secondary" disabled={props.loading} onClick={props.onRetry}>Try again</button> : null}
        </div>
      ) : null}

      {props.loading && proofs.length === 0 && invitations.length === 0 ? (
        <div className="proof-skeletons" role="status" aria-label="Loading PackProofs">
          {[0, 1, 2].map((id) => <div className="proof-skeleton" key={id} aria-hidden="true"><span /><div><i /><i /><i /></div></div>)}
        </div>
      ) : null}

      {!props.loading ? <div className="library-results" role="status">
        <span>{proofs.length} {proofs.length === 1 ? "Proof" : "Proofs"}{invitations.length ? ` · ${invitations.length} ${invitations.length === 1 ? "invitation" : "invitations"}` : ""}</span>
        {filtered ? <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button> : null}
      </div> : null}
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

      {empty && !props.error ? (
        <div className="empty-card empty-state">
          <p className="card-title">{filtered ? "No matching Proofs" : view === "completed" ? "No completed Proofs" : "No Proofs in progress"}</p>
          <p>
            {filtered
              ? "Try a different search or clear your filters to see your Proofs."
              : view === "completed"
              ? "Finalized Proofs will appear here."
              : "Create a Proof to start a record, or review an invitation."}
          </p>
          {filtered ? <button className="btn btn-secondary" type="button" onClick={clearFilters}>Reset search and filters</button> : view === "in_progress" ? (
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
