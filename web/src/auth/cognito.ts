export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

export interface CognitoSessionTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface CognitoSignUpResult {
  email: string;
  userConfirmed: boolean;
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

export function defaultCognitoConfig(): CognitoConfig {
  return {
    userPoolId: import.meta.env.VITE_PACKPROOF_COGNITO_USER_POOL_ID ?? "",
    clientId: import.meta.env.VITE_PACKPROOF_COGNITO_CLIENT_ID ?? "",
    region: import.meta.env.VITE_PACKPROOF_COGNITO_REGION ?? "us-east-1",
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

export async function cognitoSignIn(
  config: CognitoConfig,
  input: { email: string; password: string },
): Promise<CognitoSessionTokens> {
  const email = normalizeEmail(input.email);
  const result = await cognitoCall<{
    AuthenticationResult?: {
      AccessToken?: string;
      RefreshToken?: string;
      ExpiresIn?: number;
    };
    ChallengeName?: string;
  }>(config, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: input.password,
    },
  });
  if (result.ChallengeName || !result.AuthenticationResult?.AccessToken) {
    throw new CognitoAuthError("UNAUTHENTICATED", "Sign-in did not return tokens");
  }
  return {
    accessToken: result.AuthenticationResult.AccessToken,
    refreshToken: result.AuthenticationResult.RefreshToken ?? null,
    expiresAt:
      typeof result.AuthenticationResult.ExpiresIn === "number"
        ? Date.now() + result.AuthenticationResult.ExpiresIn * 1000
        : null,
  };
}

export async function cognitoSignUp(
  config: CognitoConfig,
  input: { email: string; password: string },
): Promise<CognitoSignUpResult> {
  const email = normalizeEmail(input.email);
  const result = await cognitoCall<{ UserConfirmed?: boolean }>(config, "SignUp", {
    ClientId: config.clientId,
    Username: email,
    Password: input.password,
    UserAttributes: [{ Name: "email", Value: email }],
  });
  return {
    email,
    userConfirmed: result.UserConfirmed === true,
  };
}

export async function cognitoConfirmSignUp(
  config: CognitoConfig,
  input: { email: string; confirmationCode: string },
): Promise<void> {
  await cognitoCall(config, "ConfirmSignUp", {
    ClientId: config.clientId,
    Username: normalizeEmail(input.email),
    ConfirmationCode: input.confirmationCode.trim(),
  });
}

export async function cognitoResendConfirmationCode(
  config: CognitoConfig,
  input: { email: string },
): Promise<void> {
  await cognitoCall(config, "ResendConfirmationCode", {
    ClientId: config.clientId,
    Username: normalizeEmail(input.email),
  });
}

export async function cognitoRefresh(
  config: CognitoConfig,
  refreshToken: string,
): Promise<CognitoSessionTokens> {
  const result = await cognitoCall<{
    AuthenticationResult?: {
      AccessToken?: string;
      RefreshToken?: string;
      ExpiresIn?: number;
    };
  }>(config, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: config.clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  if (!result.AuthenticationResult?.AccessToken) {
    throw new CognitoAuthError("UNAUTHENTICATED", "Session refresh failed");
  }
  return {
    accessToken: result.AuthenticationResult.AccessToken,
    refreshToken: result.AuthenticationResult.RefreshToken ?? refreshToken,
    expiresAt:
      typeof result.AuthenticationResult.ExpiresIn === "number"
        ? Date.now() + result.AuthenticationResult.ExpiresIn * 1000
        : null,
  };
}

const COGNITO_ERROR_COPY: Record<string, string> = {
  UsernameExistsException: "An account already exists for this email. Sign in instead.",
  AliasExistsException: "An account already exists for this email. Sign in instead.",
  InvalidPasswordException:
    "Choose a password with at least 8 characters, including an uppercase letter, a lowercase letter, and a number.",
  CodeMismatchException: "That verification code is incorrect.",
  ExpiredCodeException: "That verification code has expired. Request a new code.",
  LimitExceededException: "Too many attempts. Wait a few minutes and try again.",
  TooManyRequestsException: "Too many requests. Wait a moment and try again.",
  TooManyFailedAttemptsException: "Too many attempts. Wait a few minutes and try again.",
  UserNotFoundException: "No PackProof account matches that email.",
  NotAuthorizedException: "Incorrect email or password.",
  UserNotConfirmedException: "This email is not verified yet. Enter the verification code we sent, or request a new one.",
  CodeDeliveryFailureException: "We could not send a verification email. Try again in a few minutes.",
  InvalidParameterException: "Check the information you entered and try again.",
};

export function formatCognitoError(error: unknown): string {
  if (error instanceof CognitoAuthError) {
    return COGNITO_ERROR_COPY[error.code] ?? "We could not complete that request. Try again.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
