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
      USERNAME: input.email,
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

export function formatCognitoError(error: unknown): string {
  if (error instanceof CognitoAuthError) {
    if (error.code === "NotAuthorizedException") {
      return "Incorrect email or password.";
    }
    if (error.code === "UserNotFoundException") {
      return "No PackProof account matches that email.";
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
