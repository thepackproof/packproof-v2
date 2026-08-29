export type AuthMode = "dev" | "cognito";

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

export interface CognitoSessionTokens {
  accessToken: string;
  idToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

export class CognitoAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CognitoAuthError";
  }
}

export function parseAuthMode(raw: string | undefined): AuthMode {
  const normalized = (raw ?? "dev").trim().toLowerCase();
  if (normalized === "cognito") {
    return "cognito";
  }
  return "dev";
}

export function defaultAuthMode(): AuthMode {
  return parseAuthMode(process.env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE);
}

export function defaultCognitoConfig(): CognitoConfig {
  return {
    userPoolId: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID ?? "",
    clientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID ?? "",
    region: process.env.EXPO_PUBLIC_COGNITO_REGION ?? "us-east-1",
  };
}

function endpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function cognitoCall<T>(
  config: CognitoConfig,
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(endpoint(config.region), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    __type?: string;
    message?: string;
    Message?: string;
  };
  if (!response.ok) {
    const type = (payload.__type ?? "CognitoError").split("#").pop() ?? "CognitoError";
    throw new CognitoAuthError(type, payload.message ?? payload.Message ?? type);
  }
  return payload as T;
}

function tokensFromAuthResult(result: {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}): CognitoSessionTokens {
  if (!result.AccessToken) {
    throw new CognitoAuthError("UNAUTHENTICATED", "Cognito did not return an access token");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken ?? null,
    refreshToken: result.RefreshToken ?? null,
    expiresAt:
      typeof result.ExpiresIn === "number" ? Date.now() + result.ExpiresIn * 1000 : null,
  };
}

export async function cognitoSignUp(
  config: CognitoConfig,
  input: { email: string; password: string },
): Promise<{ userConfirmed: boolean }> {
  const result = await cognitoCall<{ UserConfirmed?: boolean }>(config, "SignUp", {
    ClientId: config.clientId,
    Username: input.email,
    Password: input.password,
    UserAttributes: [{ Name: "email", Value: input.email }],
  });
  return { userConfirmed: Boolean(result.UserConfirmed) };
}

export async function cognitoConfirmSignUp(
  config: CognitoConfig,
  input: { email: string; code: string },
): Promise<void> {
  await cognitoCall(config, "ConfirmSignUp", {
    ClientId: config.clientId,
    Username: input.email,
    ConfirmationCode: input.code,
  });
}

export async function cognitoResendConfirmation(
  config: CognitoConfig,
  email: string,
): Promise<void> {
  await cognitoCall(config, "ResendConfirmationCode", {
    ClientId: config.clientId,
    Username: email,
  });
}

export async function cognitoSignIn(
  config: CognitoConfig,
  input: { email: string; password: string },
): Promise<CognitoSessionTokens> {
  const result = await cognitoCall<{
    AuthenticationResult?: {
      AccessToken?: string;
      IdToken?: string;
      RefreshToken?: string;
      ExpiresIn?: number;
    };
    ChallengeName?: string;
  }>(config, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      USERNAME: input.email,
      PASSWORD: input.password,
    },
  });
  if (result.ChallengeName) {
    throw new CognitoAuthError(
      result.ChallengeName,
      "Additional authentication challenge is not supported",
    );
  }
  if (!result.AuthenticationResult) {
    throw new CognitoAuthError("UNAUTHENTICATED", "Sign-in did not return tokens");
  }
  return tokensFromAuthResult(result.AuthenticationResult);
}

export async function cognitoRefresh(
  config: CognitoConfig,
  refreshToken: string,
): Promise<CognitoSessionTokens> {
  const result = await cognitoCall<{
    AuthenticationResult?: {
      AccessToken?: string;
      IdToken?: string;
      RefreshToken?: string;
      ExpiresIn?: number;
    };
  }>(config, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      REFRESH_TOKEN: refreshToken,
    },
  });
  if (!result.AuthenticationResult) {
    throw new CognitoAuthError("UNAUTHENTICATED", "Session refresh failed");
  }
  return {
    ...tokensFromAuthResult(result.AuthenticationResult),
    refreshToken: result.AuthenticationResult.RefreshToken ?? refreshToken,
  };
}

export async function cognitoForgotPassword(
  config: CognitoConfig,
  email: string,
): Promise<void> {
  await cognitoCall(config, "ForgotPassword", {
    ClientId: config.clientId,
    Username: email,
  });
}

export async function cognitoConfirmForgotPassword(
  config: CognitoConfig,
  input: { email: string; code: string; password: string },
): Promise<void> {
  await cognitoCall(config, "ConfirmForgotPassword", {
    ClientId: config.clientId,
    Username: input.email,
    ConfirmationCode: input.code,
    Password: input.password,
  });
}

export async function cognitoGlobalSignOut(
  config: CognitoConfig,
  accessToken: string,
): Promise<void> {
  try {
    await cognitoCall(config, "GlobalSignOut", {
      AccessToken: accessToken,
    });
  } catch {
    // Local sign-out still proceeds if the remote revoke fails.
  }
}

export function formatCognitoError(error: unknown): string {
  if (error instanceof CognitoAuthError) {
    switch (error.code) {
      case "UserNotConfirmedException":
        return "Email verification required. Enter the verification code sent to your email.";
      case "CodeMismatchException":
        return "That verification code is invalid.";
      case "ExpiredCodeException":
        return "That verification code has expired. Request a new code.";
      case "NotAuthorizedException":
        return "Incorrect email or password.";
      case "UserNotFoundException":
        return "No PackProof account matches that email.";
      case "UsernameExistsException":
        return "An account already exists for that email.";
      case "InvalidPasswordException":
        return error.message || "Password does not meet the account requirements.";
      case "LimitExceededException":
        return "Too many attempts. Wait a moment and try again.";
      case "InvalidParameterException":
        return error.message || "Check the account details and try again.";
      default:
        return error.message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
