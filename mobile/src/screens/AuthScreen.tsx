import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { colors, spacing, typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { Logo } from "../ui/Logo";

export function AuthScreen() {
  const app = usePackProof();
  return (
    <AppScreen>
      <View style={styles.hero}>
        <Logo size={64} />
        <Text style={styles.brand}>PackProof</Text>
        <Text style={styles.tag}>Neutral evidence records for commerce</Text>
      </View>
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}

      {app.authPane === "signIn" ? (
        <View style={styles.card}>
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
              <FormField
                label="Password"
                value={app.password}
                onChangeText={app.setPassword}
                secureTextEntry
              />
            </>
          )}
          <Button label="Sign in" onPress={() => void app.signIn()} loading={app.busy} />
          {app.authMode === "cognito" ? (
            <>
              <Button label="Create account" onPress={() => app.setAuthPane("createAccount")} variant="secondary" disabled={app.busy} />
              <Button label="Forgot password" onPress={() => app.setAuthPane("forgot")} variant="tertiary" disabled={app.busy} />
              <Button label="I have a verification code" onPress={() => app.setAuthPane("verify")} variant="tertiary" disabled={app.busy} />
            </>
          ) : null}
        </View>
      ) : null}

      {app.authPane === "createAccount" ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Create account</Text>
          <FormField label="Email" value={app.email} onChangeText={app.setEmail} keyboardType="email-address" />
          <FormField label="Password" value={app.password} onChangeText={app.setPassword} secureTextEntry />
          <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />
          <FormField label="Display name" value={app.displayNameInput} onChangeText={app.setDisplayNameInput} autoCapitalize="words" />
          <Button label="Create account" onPress={() => void app.createAccount()} loading={app.busy} />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "verify" ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Verify email</Text>
          <Text style={styles.body}>Enter the verification code sent to {app.email || "your email"}.</Text>
          <FormField label="Email" value={app.email} onChangeText={app.setEmail} keyboardType="email-address" />
          <FormField label="Verification code" value={app.verificationCode} onChangeText={app.setVerificationCode} keyboardType="number-pad" />
          <Button label="Verify email" onPress={() => void app.verifyEmail()} loading={app.busy} />
          <Button label="Resend code" onPress={() => void app.resendVerification()} variant="secondary" disabled={app.busy} />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "forgot" ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Forgot password</Text>
          <FormField label="Email" value={app.email} onChangeText={app.setEmail} keyboardType="email-address" />
          <Button label="Send reset code" onPress={() => void app.sendReset()} loading={app.busy} />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {app.authPane === "reset" ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Reset password</Text>
          <Text style={styles.body}>Enter the reset code sent to {app.email || "your email"}.</Text>
          <FormField label="Reset code" value={app.verificationCode} onChangeText={app.setVerificationCode} keyboardType="number-pad" />
          <FormField label="New password" value={app.newPassword} onChangeText={app.setNewPassword} secureTextEntry />
          <Button label="Reset password" onPress={() => void app.resetPassword()} loading={app.busy} />
          <Button label="Back to sign in" onPress={() => app.setAuthPane("signIn")} variant="tertiary" />
        </View>
      ) : null}

      {__DEV__ ? (
        <View style={styles.dev}>
          <Text style={styles.devTitle}>Developer options</Text>
          {app.allowsApiOverride ? (
            <FormField label="API base URL" value={app.apiBaseUrl} onChangeText={app.setApiBaseUrl} />
          ) : (
            <Text style={styles.body}>{app.apiBaseUrl}</Text>
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
                  <FormField label="Cognito app client ID" value={app.cognitoClientId} onChangeText={app.setCognitoClientId} />
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

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: spacing.sm, paddingTop: spacing.xxl, paddingBottom: spacing.lg },
  brand: { ...typography.pageTitle, color: colors.navy },
  tag: { ...typography.secondary, color: colors.slate, textAlign: "center" },
  card: { gap: spacing.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: spacing.lg },
  heading: { ...typography.sectionTitle, color: colors.navy },
  body: { ...typography.body, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
  dev: { gap: spacing.sm, paddingTop: spacing.lg },
  devTitle: { ...typography.caption, color: colors.slate },
});
