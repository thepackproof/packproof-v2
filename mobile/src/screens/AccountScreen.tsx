import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { displayName } from "../copy/format";
import { ACCOUNT_DELETION_COPY, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../copy/legal";
import { providerDisplay } from "../copy/status";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import type { AppearancePreference } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { InfoCard } from "../ui/ProofCard";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";

const APPEARANCE_OPTIONS: Array<{ id: AppearancePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Match this device" },
  { id: "light", label: "Light", hint: "Always use light PackProof" },
  { id: "dark", label: "Dark", hint: "Always use dark PackProof" },
];

export function AccountScreen() {
  const app = usePackProof();
  const theme = useTheme();
  const { colors } = theme;
  const session = app.session;
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
  }, []);
  if (!session) {
    return null;
  }

  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Account" onBack={app.goBack} />
      <OfflineBanner visible={app.offline} />
      <ErrorBanner message={app.error} />
      <InfoCard>
        <Text style={[styles.name, { color: colors.textPrimary }]}>
          {displayName({ displayName: session.displayName, username: session.username, email: session.email })}
        </Text>
        {session.username ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>@{session.username}</Text>
        ) : (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>Username not set</Text>
        )}
      </InfoCard>
      <SectionHeader title="Profile" />
      {!session.username ? (
        <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />
      ) : null}
      <FormField
        label="Display name"
        value={app.displayNameInput}
        onChangeText={app.setDisplayNameInput}
        autoCapitalize="words"
      />
      <Button
        label={session.username ? "Update display name" : "Save profile"}
        onPress={() => void app.saveProfile()}
        loading={app.busy}
      />

      <SectionHeader title="Appearance" />
      <View style={styles.appearance} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
        {APPEARANCE_OPTIONS.map((option) => {
          const selected = theme.preference === option.id;
          return (
            <Pressable
              key={option.id}
              onPress={() => void theme.setPreference(option.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[
                styles.appearanceRow,
                {
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: selected ? colors.accentSoft : colors.surface,
                },
              ]}
            >
              <View>
                <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{option.label}</Text>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>{option.hint}</Text>
              </View>
              <View
                style={[
                  styles.radio,
                  { borderColor: selected ? colors.accent : colors.border },
                ]}
              >
                {selected ? <View style={[styles.radioDot, { backgroundColor: colors.accent }]} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <SectionHeader title="Connected marketplaces" />
      {app.connections.length === 0 ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          No marketplace connections on this account yet. Marketplace sign-in is not available in this PackProof release.
        </Text>
      ) : (
        app.connections.map((connection) => (
          <InfoCard key={connection.connectionId}>
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>
              {connection.providerDisplay || providerDisplay(connection.provider)}
            </Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.status}</Text>
            {connection.externalAccountReference ? (
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.externalAccountReference}</Text>
            ) : null}
          </InfoCard>
        ))
      )}

      <SectionHeader title="Packing tools" />
      <Button label="Packing Station" onPress={() => app.go("station")} variant="secondary" />

      <SectionHeader title="About PackProof" />
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        PackProof creates tamper-evident records for commerce. It records what was submitted, when, and by whom. It does
        not decide who is right.
      </Text>
      <Button label="Terms of Service" variant="tertiary" onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL)} />
      <Button label="Privacy Policy" variant="tertiary" onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} />

      <SectionHeader title="Account deletion" />
      <Text style={[styles.body, { color: colors.textSecondary }]}>{ACCOUNT_DELETION_COPY}</Text>
      <Button
        label="Open Privacy Policy"
        variant="secondary"
        onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)}
      />

      {__DEV__ ? <Button label="Developer tools" onPress={() => app.go("dev")} variant="tertiary" /> : null}

      <Button
        label="Sign out"
        onPress={() => {
          setSigningOut(true);
          void app.signOut().finally(() => setSigningOut(false));
        }}
        variant="destructive"
        disabled={app.busy || signingOut}
        loading={signingOut}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  name: { ...typography.sectionTitle },
  cardTitle: { ...typography.cardTitle },
  meta: { ...typography.secondary },
  body: { ...typography.body },
  appearance: { gap: spacing.sm },
  appearanceRow: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
