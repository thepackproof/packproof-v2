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
import { colors, radii, spacing, typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { AvatarButton } from "../ui/AvatarButton";
import { BottomSheet } from "../ui/Sheets";
import { CreateFab } from "../ui/CreateFab";
import { EmptyState, OfflineBanner } from "../ui/EmptyState";
import { Logo } from "../ui/Logo";
import { ProofCard } from "../ui/ProofCard";

export function MyProofsScreen() {
  const app = usePackProof();
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

  return (
    <View style={styles.root}>
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
            <Text style={styles.brandName}>PackProof</Text>
          </View>
          <AvatarButton
            displayName={app.session?.displayName}
            username={app.session?.username}
            notify={app.pendingInvites.length > 0}
            onPress={() => app.go("account")}
          />
        </View>
        <Text style={styles.pageTitle}>My Proofs</Text>
        <View style={styles.tabs} accessibilityRole="tablist">
          <LibraryTab
            label="In Progress"
            icon="time-outline"
            selected={library.view === "in_progress"}
            onPress={() => app.setProofsView("in_progress")}
          />
          <LibraryTab
            label="Completed"
            icon="checkmark-outline"
            selected={library.view === "completed"}
            onPress={() => app.setProofsView("completed")}
          />
        </View>
        <View style={styles.searchRow}>
          <View style={styles.search}>
            <Ionicons name="search-outline" size={18} color={colors.slate} />
            <TextInput
              value={library.query}
              onChangeText={app.setProofsQuery}
              placeholder="Search proofs..."
              placeholderTextColor={colors.textMuted}
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <Pressable
            onPress={() => setFilterOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Filter and sort"
            style={styles.filterBtn}
          >
            <Ionicons name="options-outline" size={20} color={colors.navy} />
          </Pressable>
        </View>
        <OfflineBanner visible={app.offline} />
        {app.error ? <Text style={styles.error}>{app.error}</Text> : null}

        {library.view === "in_progress" && invitations.map((invite) => (
          <ProofCard
            key={invite.invitationId}
            model={invitationCardModel(invite)}
            onPress={() => app.openInvitation(invite)}
          />
        ))}

        {proofs.map((item) => (
          <ProofCard
            key={item.proofId}
            model={toProofCardModel(item, {
              captureStatus: app.captureStatus,
              hasLocalCapture: Boolean(app.localCapture),
              captureProofId: app.session?.proofId,
            })}
            onPress={() => void app.run(async () => app.openProof(item.proofId))}
          />
        ))}

        {proofs.length === 0 && invitations.length === 0 ? (
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
        <Text style={styles.sheetLabel}>Sort</Text>
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
        <Text style={styles.sheetLabel}>Role</Text>
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
            <Text style={styles.sheetLabel}>Carrier</Text>
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

function LibraryTab(props: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: props.selected }}
      style={[styles.tab, props.selected ? styles.tabActive : null]}
    >
      <Ionicons name={props.icon} size={16} color={props.selected ? colors.white : colors.navy} />
      <Text style={[styles.tabLabel, props.selected ? styles.tabLabelActive : null]}>{props.label}</Text>
    </Pressable>
  );
}

function ChipRow<T extends string>(props: {
  options: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  return (
    <View style={styles.chips}>
      {props.options.map((option) => {
        const selected = props.selected === option.id;
        return (
          <Pressable
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            style={[styles.chip, selected ? styles.chipActive : null]}
          >
            <Text style={[styles.chipLabel, selected ? styles.chipLabelActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  brandName: { ...typography.sectionTitle, color: colors.navy },
  pageTitle: { ...typography.pageTitle, color: colors.navy },
  tabs: { flexDirection: "row", gap: spacing.sm },
  tab: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  tabActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  tabLabel: { ...typography.secondaryStrong, color: colors.navy },
  tabLabelActive: { color: colors.white },
  searchRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  search: {
    flex: 1,
    minHeight: 48,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.navy, paddingVertical: spacing.sm },
  filterBtn: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  error: { ...typography.secondary, color: colors.danger },
  sheetLabel: { ...typography.secondaryStrong, color: colors.navy, marginTop: spacing.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  chipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipLabel: { ...typography.secondaryStrong, color: colors.navy },
  chipLabelActive: { color: colors.white },
});
