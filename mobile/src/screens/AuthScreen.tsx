import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../copy/legal";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { Logo } from "../ui/Logo";
import { ErrorBanner } from "../ui/EmptyState";

export function AuthScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const passwordsMatch = confirmPassword === app.password;
  const canCreate = acceptedLegal && app.email.trim().length > 0 && app.password.length > 0 && passwordsMatch;

  return (
    <AppScreen extraBottom={24}>
      <View style={styles.hero}>
        <Logo size={64} />
        <Text style={[styles.brand, { color: colors.textPrimary }]}>PackProof</Text>
        <Text style={[styles.tag, { color: colors.textSecondary }]}>
          Neutral evidence records for commerce transactions.
        </Text>
      </View>
      <ErrorBanner message={app.error} />

      {app.authPane === "signIn" ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {app.authMode === "dev" ? (
            <FormField label="Development subject" value={app.subject} onChangeText={app.setSubject} />
          ) : (
            <>
              <FormField
                label="Email"
                value={app.email}
                onChangeText={app.setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <FormField label="Password" value={app.password} onChangeText={app.setPassword} secureTextEntry />
            </>
          )}
          <Button label="Sign in" onPress={() => void app.signIn()} loading={app.busy} haptic="light" />
          {app.authMode === "cognito" ? (
            <>
              <Button
                label="Create account"
                onPress={() => app.setAuthPane("createAccount")}
                variant="secondary"
                disabled={app.busy}
              />
              <Button
                label="Forgot password"
                onPress={() => app.setAuthPane("forgot")}
                variant="tertiary"
                disabled={app.busy}
              />
              <Button
                label="I have a verification code"
                onPress={() => app.setAuthPane("verify")}
                variant="tertiary"
                disabled={app.busy}
              />
            </>
          ) : null}
        </View>
      ) : null}

      {app.authPane === "createAccount" ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Create account</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            Create a PackProof account with email and password. This is the supported sign-in method.
          </Text>
          <FormField label="Email" value={app.email} onChangeText={app.setEmail} keyboardType="email-address" />
          <FormField label="Password" value={app.password} onChangeText={app.setPassword} secureTextEntry />
          <FormField label="Confirm password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry />
          <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />
          <FormField
            label="Display name"
            value={app.displayNameInput}
            onChangeText={app.setDisplayNameInput}
            autoCapitalize="words"
          />
          {!passwordsMatch && confirmPassword.length > 0 ? (
            <Text style={[styles.error, { color: colors.error }]}>Passwords do not match.</Text>
          ) : null}
          <Pressable
            onPress={() => setAcceptedLegal((value) => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: acceptedLegal }}
            style={styles.legalRow}
          >
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: acceptedLegal ? colors.accent : colors.border,
                  backgroundColor: acceptedLegal ? colors.accent : "transparent",
                },
              ]}
            />
            <Text style={[styles.body, { color: colors.textSecondary, flex: 1 }]}>
              I agree to the Terms of Service and acknowledge the Privacy Policy.
            </Text>
          </Pressable>
          <LegalLinks />
          <Button
            label="Create account"
            onPress={() => void app.createAccount()}
            loading={app.busy}
            disabled={!canCreate}
          />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "verify" ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Verify email</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            Enter the verification code sent to {app.email || "your email"}.
          </Text>
          <FormField label="Email" value={app.email} onChangeText={app.setEmail} keyboardType="email-address" />
          <FormField
            label="Verification code"
            value={app.verificationCode}
            onChangeText={app.setVerificationCode}
            keyboardType="number-pad"
          />
          <Button label="Verify email" onPress={() => void app.verifyEmail()} loading={app.busy} />
          <Button
            label="Resend code"
            onPress={() => void app.resendVerification()}
            variant="secondary"
            disabled={app.busy}
          />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "forgot" ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Forgot password</Text>
          <FormField label="Email" value={app.email} onChangeText={app.setEmail} keyboardType="email-address" />
          <Button label="Send reset code" onPress={() => void app.sendReset()} loading={app.busy} />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "reset" ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Reset password</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            Enter the reset code sent to {app.email || "your email"}.
          </Text>
          <FormField
            label="Reset code"
            value={app.verificationCode}
            onChangeText={app.setVerificationCode}
            keyboardType="number-pad"
          />
          <FormField label="New password" value={app.newPassword} onChangeText={app.setNewPassword} secureTextEntry />
          <Button label="Reset password" onPress={() => void app.resetPassword()} loading={app.busy} />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "signIn" ? (
        <View style={styles.legalFooter}>
          <LegalLinks />
        </View>
      ) : null}

      {__DEV__ ? (
        <View style={styles.dev}>
          <Text style={[styles.devTitle, { color: colors.textSecondary }]}>Developer options</Text>
          {app.allowsApiOverride ? (
            <FormField label="API base URL" value={app.apiBaseUrl} onChangeText={app.setApiBaseUrl} />
          ) : (
            <Text style={[styles.body, { color: colors.textSecondary }]}>{app.apiBaseUrl}</Text>
          )}
          {app.allowsDevAuth ? (
            <Button
              label={app.authMode === "dev" ? "Using development sign-in" : "Use development sign-in"}
              onPress={() => app.setAuthMode("dev")}
              variant="secondary"
              disabled={app.busy}
            />
          ) : null}
          <Button
            label="Use PackProof account"
            onPress={() => app.setAuthMode("cognito")}
            variant="secondary"
            disabled={app.busy}
          />
          {app.authMode === "cognito" && app.allowsApiOverride ? (
            <>
              <Button
                label={app.showCognitoSettings ? "Hide Cognito settings" : "Show Cognito settings"}
                onPress={() => app.setShowCognitoSettings((value) => !value)}
                variant="tertiary"
              />
              {app.showCognitoSettings ? (
                <>
                  <FormField label="Cognito User Pool ID" value={app.cognitoPoolId} onChangeText={app.setCognitoPoolId} />
                  <FormField
                    label="Cognito app client ID"
                    value={app.cognitoClientId}
                    onChangeText={app.setCognitoClientId}
                  />
                  <FormField label="Cognito region" value={app.cognitoRegion} onChangeText={app.setCognitoRegion} />
                </>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </AppScreen>
  );
}

function LegalLinks() {
  const { colors } = useTheme();
  return (
    <Text style={[styles.legal, { color: colors.textMuted }]}>
      <Text onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL)} style={[styles.link, { color: colors.accent }]}>
        Terms of Service
      </Text>
      {"  ·  "}
      <Text onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} style={[styles.link, { color: colors.accent }]}>
        Privacy Policy
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: spacing.sm, paddingTop: spacing.xxl, paddingBottom: spacing.lg },
  brand: { ...typography.pageTitle },
  tag: { ...typography.secondary, textAlign: "center" },
  card: { gap: spacing.md, borderWidth: 1, borderRadius: 16, padding: spacing.lg },
  heading: { ...typography.sectionTitle },
  body: { ...typography.body },
  error: { ...typography.secondary },
  legalRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, marginTop: 2 },
  legalFooter: { alignItems: "center" },
  legal: { ...typography.caption, textAlign: "center" },
  link: { ...typography.caption },
  dev: { gap: spacing.sm, paddingTop: spacing.lg },
  devTitle: { ...typography.caption },
});
