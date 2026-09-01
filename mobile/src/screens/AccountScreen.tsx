import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { displayName } from "../copy/format";
import { providerDisplay } from "../copy/status";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { InfoCard } from "../ui/ProofCard";
import { OfflineBanner } from "../ui/EmptyState";

export function AccountScreen() {
  const app = usePackProof();
  const session = app.session;
  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
  }, []);
  if (!session) {
    return null;
  }

  return (
    <AppScreen extraBottom={24} bottomInset={false}>
      <AppHeader showLogo title="Account" />
      <OfflineBanner visible={app.offline} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <InfoCard>
        <Text style={styles.name}>{displayName({ displayName: session.displayName, username: session.username, email: session.email })}</Text>
        {session.username ? <Text style={styles.meta}>@{session.username}</Text> : <Text style={styles.meta}>Username not set</Text>}
      </InfoCard>
      <SectionHeader title="Profile" />
      {!session.username ? (
        <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />
      ) : null}
      <FormField label="Display name" value={app.displayNameInput} onChangeText={app.setDisplayNameInput} autoCapitalize="words" />
      <Button label={session.username ? "Update display name" : "Save profile"} onPress={() => void app.saveProfile()} loading={app.busy} />

      <SectionHeader title="Connected marketplaces" />
      {app.connections.length === 0 ? (
        <Text style={styles.meta}>No marketplace connections on this account yet.</Text>
      ) : (
        app.connections.map((connection) => (
          <InfoCard key={connection.connectionId}>
            <Text style={styles.cardTitle}>{connection.providerDisplay || providerDisplay(connection.provider)}</Text>
            <Text style={styles.meta}>{connection.status}</Text>
            {connection.externalAccountReference ? <Text style={styles.meta}>{connection.externalAccountReference}</Text> : null}
          </InfoCard>
        ))
      )}

      <SectionHeader title="Packing tools" />
      <Button label="Packing Station" onPress={() => app.go("station")} variant="secondary" />

      <SectionHeader title="About PackProof" />
      <Text style={styles.body}>
        PackProof creates tamper-evident records for commerce. It records what was submitted, when, and by whom. It does not decide who is right.
      </Text>

      {__DEV__ ? <Button label="Developer tools" onPress={() => app.go("dev")} variant="tertiary" /> : null}

      <SectionHeader title="Advanced options" />
      <FormField label="Invitation ID" value={app.invitationInput} onChangeText={app.setInvitationInput} />
      <Button
        label="Join with invitation ID"
        onPress={() => void app.acceptInvite(app.invitationInput.trim())}
        variant="secondary"
        disabled={app.busy || !app.invitationInput.trim()}
      />

      <Button label="Sign out" onPress={() => void app.signOut()} variant="destructive" disabled={app.busy} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  name: { ...typography.sectionTitle, color: colors.navy },
  cardTitle: { ...typography.cardTitle, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  body: { ...typography.body, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
});
