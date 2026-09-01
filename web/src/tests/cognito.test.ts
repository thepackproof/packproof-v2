import { describe, expect, it, vi } from "vitest";
import {
  CognitoAuthError,
  cognitoConfirmSignUp,
  cognitoResendConfirmationCode,
  cognitoSignIn,
  cognitoSignUp,
  formatCognitoError,
} from "../auth/cognito";

const config = {
  userPoolId: "us-east-1_test",
  clientId: "test-client",
  region: "us-east-1",
};

function cognitoResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/x-amz-json-1.1" },
  });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  return {
    url: String(url),
    target: (init as RequestInit | undefined)?.headers
      ? String(((init as RequestInit).headers as Record<string, string>)["X-Amz-Target"])
      : "",
    body: JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as Record<string, unknown>,
  };
}

describe("Cognito account client", () => {
  it("signs up with the normalized email as username and email attribute", async () => {
    const fetchMock = vi.fn(async () => cognitoResponse({ UserConfirmed: false }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await cognitoSignUp(config, {
      email: "  Alex@Example.com ",
      password: "SecretPass1",
    });
    expect(result).toEqual({ email: "alex@example.com", userConfirmed: false });
    const call = lastCall(fetchMock);
    expect(call.url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(call.target).toBe("AWSCognitoIdentityProviderService.SignUp");
    expect(call.body).toEqual({
      ClientId: "test-client",
      Username: "alex@example.com",
      Password: "SecretPass1",
      UserAttributes: [{ Name: "email", Value: "alex@example.com" }],
    });
    vi.unstubAllGlobals();
  });

  it("confirms sign-up with the verification code", async () => {
    const fetchMock = vi.fn(async () => cognitoResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await cognitoConfirmSignUp(config, {
      email: "alex@example.com",
      confirmationCode: " 123456 ",
    });
    const call = lastCall(fetchMock);
    expect(call.target).toBe("AWSCognitoIdentityProviderService.ConfirmSignUp");
    expect(call.body).toEqual({
      ClientId: "test-client",
      Username: "alex@example.com",
      ConfirmationCode: "123456",
    });
    vi.unstubAllGlobals();
  });

  it("resends the confirmation code", async () => {
    const fetchMock = vi.fn(async () => cognitoResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await cognitoResendConfirmationCode(config, { email: "Alex@Example.com" });
    const call = lastCall(fetchMock);
    expect(call.target).toBe("AWSCognitoIdentityProviderService.ResendConfirmationCode");
    expect(call.body).toEqual({
      ClientId: "test-client",
      Username: "alex@example.com",
    });
    vi.unstubAllGlobals();
  });

  it("signs in existing users with USER_PASSWORD_AUTH", async () => {
    const fetchMock = vi.fn(async () =>
      cognitoResponse({
        AuthenticationResult: {
          AccessToken: "access-token",
          RefreshToken: "refresh-token",
          ExpiresIn: 3600,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await cognitoSignIn(config, { email: "alex@example.com", password: "SecretPass1" });
    expect(tokens.accessToken).toBe("access-token");
    const call = lastCall(fetchMock);
    expect(call.target).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(call.body).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "test-client",
      AuthParameters: { USERNAME: "alex@example.com", PASSWORD: "SecretPass1" },
    });
    vi.unstubAllGlobals();
  });

  it("maps Cognito error codes to PackProof copy", () => {
    const cases: Array<[string, string]> = [
      ["UsernameExistsException", "An account already exists for this email. Sign in instead."],
      ["InvalidPasswordException", "Choose a password with at least 8 characters, including an uppercase letter, a lowercase letter, and a number."],
      ["CodeMismatchException", "That verification code is incorrect."],
      ["ExpiredCodeException", "That verification code has expired. Request a new code."],
      ["LimitExceededException", "Too many attempts. Wait a few minutes and try again."],
      ["TooManyRequestsException", "Too many requests. Wait a moment and try again."],
      ["UserNotFoundException", "No PackProof account matches that email."],
      ["NotAuthorizedException", "Incorrect email or password."],
    ];
    for (const [code, copy] of cases) {
      expect(formatCognitoError(new CognitoAuthError(code, "raw Cognito implementation message"))).toBe(
        copy,
      );
    }
  });

  it("does not dump raw Cognito messages for mapped or unknown codes", () => {
    expect(
      formatCognitoError(new CognitoAuthError("CodeMismatchException", "1 validation error detected")),
    ).not.toContain("validation error");
    expect(formatCognitoError(new CognitoAuthError("SomeNewException", "Internal stack"))).toBe(
      "We could not complete that request. Try again.",
    );
  });
});
