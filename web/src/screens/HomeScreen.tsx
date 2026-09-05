import { useViewState } from "../navigation-context";
import { useMemo } from "react";
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
import { Notice } from "../components/Notice";
import { Glyph } from "../site/Brand";

export function HomeScreen(props: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  loading: boolean;
  error: string | null;
  onOpenProof: (proofId: string) => void;
  onCreate: () => void;
  onOpenInvitation: (invite: InvitationInboxView) => void;
}) {
  const [view, setView] = useViewState<ProofLibraryView>("library.view", "in_progress");
  const [query, setQuery] = useViewState("library.query", "");
  const [sort, setSort] = useViewState<ProofLibrarySort>("library.sort", "newest");
  const [role, setRole] = useViewState<ProofRoleFilter>("library.role", "all");
  const [carrier, setCarrier] = useViewState<string | null>("library.carrier", null);
  const [filterOpen, setFilterOpen] = useViewState("library.filterOpen", false);

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
  const hasFilters = Boolean(query.trim() || role !== "all" || carrier || sort !== "newest");
  const clearFilters = () => { setQuery(""); setRole("all"); setCarrier(null); setSort("newest"); };
  const empty = !props.error && !props.loading && proofs.length === 0 && invitations.length === 0;

  return (
    <main className="page library-page">
      <p className="workspace-overline">Workspace / Proofs</p>
      <div className="workspace-heading"><div><h1 className="page-title">My Proofs</h1><p>Every shipment. Every detail. All in one place.</p></div><button className="btn" onClick={props.onCreate}><Glyph name="plus" size={16} />New Proof</button></div>
      <div className="library-section-heading"><h2>Your Proof library</h2><span>Search, filter, and keep moving.</span></div>
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

      {hasFilters ? <div className="active-filter-chips" aria-label="Active filters">
        <Glyph name="grid" size={15} />
        {query.trim() && <button onClick={() => setQuery("")} aria-label="Remove search filter"><span>Search</span><strong>{query.trim()}</strong><Glyph name="close" size={13} /></button>}
        {role !== "all" && <button onClick={() => setRole("all")} aria-label="Remove role filter"><span>Role is</span><strong>{role}</strong><Glyph name="close" size={13} /></button>}
        {carrier && <button onClick={() => setCarrier(null)} aria-label="Remove carrier filter"><span>Carrier is</span><strong>{carrier}</strong><Glyph name="close" size={13} /></button>}
        {sort !== "newest" && <button onClick={() => setSort("newest")} aria-label="Reset sort"><span>Sort</span><strong>{sort === "oldest" ? "Oldest first" : sort === "price_high" ? "Price high to low" : "Price low to high"}</strong><Glyph name="close" size={13} /></button>}
        <button className="clear-filters" onClick={clearFilters}>Clear all</button>
      </div> : null}
      {props.error ? <Notice title="We couldn’t load your Proofs" kind="error">{props.error}</Notice> : null}

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
            {hasFilters ? "No matching Proofs" : view === "completed" ? "No completed Proofs" : "No Proofs in progress"}
          </p>
          <p>
            {hasFilters ? "Try a different search or clear your filters." : view === "completed"
              ? "Finalized Proofs will appear here."
              : "Create a Proof to start a record, or review an invitation."}
          </p>
          {hasFilters ? <button className="btn btn-secondary" onClick={clearFilters}>Clear filters</button> : view === "in_progress" ? (
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
