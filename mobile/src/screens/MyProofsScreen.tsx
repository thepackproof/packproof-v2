import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import {
  filterProofLibrary,
  invitationCardModel,
  toProofCardModel,
  uniqueCarriers,
} from "../copy/presentation";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppScreen } from "../ui/AppScreen";
import { AvatarButton } from "../ui/AvatarButton";
import { BottomSheet } from "../ui/Sheets";
import { CreateFab } from "../ui/CreateFab";
import { EmptyState, ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { Logo } from "../ui/Logo";
import { ProofCard } from "../ui/ProofCard";
import { ProofCardSkeleton } from "../ui/Skeleton";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import { FadeSlideIn } from "../ui/motion";

export function MyProofsScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const [filterOpen, setFilterOpen] = useState(false);
  const library = app.proofsLibrary;

  useEffect(() => {
    void app.syncWorkspace().catch(() => undefined);
  }, []);

  const carriers = useMemo(() => uniqueCarriers(app.proofCollection), [app.proofCollection]);
  const proofs = useMemo(
    () =>
      filterProofLibrary(app.proofCollection, {
        view: library.view,
        query: library.query,
        sort: library.sort,
        role: library.role,
        carrier: library.carrier,
      }),
    [app.proofCollection, library],
  );
  const invitations =
    library.view === "in_progress" && !library.role && !library.carrier
      ? app.pendingInvites.filter((invite) => {
          const query = library.query.trim().toLowerCase();
          if (!query) {
            return true;
          }
          return [invite.transaction.itemTitle, invite.inviter.displayName, invite.inviter.username]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query);
        })
      : [];
  const showSkeleton = app.busy && proofs.length === 0 && invitations.length === 0 && !app.error;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <AppScreen
        onRefresh={() => void app.syncWorkspace()}
        refreshing={app.busy}
        extraBottom={108}
        bottomInset={false}
        contentOffsetY={library.scrollOffset}
        onScrollOffset={app.setProofsScrollOffset}
      >
        <View style={styles.topBar}>
          <View style={styles.brand}>
            <Logo size={32} />
            <Text style={[styles.brandName, { color: colors.textPrimary }]}>PackProof</Text>
          </View>
          <AvatarButton
            displayName={app.session?.displayName}
            username={app.session?.username}
            notify={app.pendingInvites.length > 0}
            onPress={() => app.go("account")}
          />
        </View>
        <Text style={[styles.pageTitle, { color: colors.textPrimary }]}>My Proofs</Text>
        <SegmentedTabs
          options={[
            { id: "in_progress", label: "In Progress", icon: "time-outline" },
            { id: "completed", label: "Completed", icon: "checkmark-outline" },
          ]}
          selected={library.view}
          onSelect={app.setProofsView}
        />
        <View style={styles.searchRow}>
          <View
            style={[
              styles.search,
              { borderColor: colors.border, backgroundColor: colors.inputBackground },
            ]}
          >
            <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
            <TextInput
              value={library.query}
              onChangeText={app.setProofsQuery}
              placeholder="Search proofs..."
              placeholderTextColor={colors.textMuted}
              style={[styles.searchInput, { color: colors.textPrimary }]}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Search proofs"
            />
          </View>
          <Pressable
            onPress={() => setFilterOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Filter and sort"
            style={[styles.filterBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
          >
            <Ionicons name="options-outline" size={20} color={colors.textPrimary} />
          </Pressable>
        </View>
        <OfflineBanner visible={app.offline} />
        <ErrorBanner message={app.error} />

        {showSkeleton ? (
          <>
            <ProofCardSkeleton />
            <ProofCardSkeleton />
            <ProofCardSkeleton />
          </>
        ) : null}

        {library.view === "in_progress" &&
          invitations.map((invite, index) => (
            <FadeSlideIn key={invite.invitationId} index={index}>
              <ProofCard model={invitationCardModel(invite)} onPress={() => app.openInvitation(invite)} />
            </FadeSlideIn>
          ))}

        {proofs.map((item, index) => (
          <FadeSlideIn key={item.proofId} index={invitations.length + index}>
            <ProofCard
              model={toProofCardModel(item, {
                captureStatus: app.captureStatus,
                hasLocalCapture: Boolean(app.localCapture),
                captureProofId: app.session?.proofId,
              })}
              onPress={() => void app.run(async () => app.openProof(item.proofId))}
            />
          </FadeSlideIn>
        ))}

        {!showSkeleton && proofs.length === 0 && invitations.length === 0 ? (
          <EmptyState
            title={library.view === "completed" ? "No completed Proofs" : "No Proofs in progress"}
            body={
              library.view === "completed"
                ? "Finalized Proofs will appear here."
                : "Create a Proof to start a record, or review an invitation."
            }
            actionLabel={library.view === "in_progress" ? "Create a Proof" : undefined}
            onAction={library.view === "in_progress" ? () => app.go("create") : undefined}
            icon={library.view === "completed" ? "checkmark-circle-outline" : "cube-outline"}
          />
        ) : null}
      </AppScreen>
      <CreateFab onPress={() => app.go("create")} />
      <BottomSheet visible={filterOpen} title="Sort and filter" onClose={() => setFilterOpen(false)}>
        <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Sort</Text>
        <ChipRow
          options={[
            { id: "newest", label: "Newest first" },
            { id: "oldest", label: "Oldest first" },
            { id: "price_high", label: "Price high to low" },
            { id: "price_low", label: "Price low to high" },
          ]}
          selected={library.sort}
          onSelect={app.setProofsSort}
        />
        <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Role</Text>
        <ChipRow
          options={[
            { id: "all", label: "All" },
            { id: "seller", label: "Seller" },
            { id: "buyer", label: "Buyer" },
          ]}
          selected={library.role}
          onSelect={app.setProofsRoleFilter}
        />
        {carriers.length > 0 ? (
          <>
            <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Carrier</Text>
            <ChipRow
              options={[{ id: "", label: "All" }, ...carriers.map((carrier) => ({ id: carrier, label: carrier }))]}
              selected={library.carrier ?? ""}
              onSelect={(value) => app.setProofsCarrierFilter(value || null)}
            />
          </>
        ) : null}
      </BottomSheet>
    </View>
  );
}

function ChipRow<T extends string>(props: {
  options: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.chips}>
      {props.options.map((option) => {
        const selected = props.selected === option.id;
        return (
          <Pressable
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
              styles.chip,
              {
                borderColor: selected ? colors.primary : colors.border,
                backgroundColor: selected ? colors.primary : colors.surface,
              },
            ]}
          >
            <Text style={[styles.chipLabel, { color: selected ? colors.textOnPrimary : colors.textPrimary }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  brandName: { ...typography.sectionTitle },
  pageTitle: { ...typography.pageTitle },
  searchRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  search: {
    flex: 1,
    minHeight: 48,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, paddingVertical: spacing.sm },
  filterBtn: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetLabel: { ...typography.secondaryStrong, marginTop: spacing.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: "center",
  },
  chipLabel: { ...typography.secondaryStrong },
});
