import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { saveSession } from "../auth/session";
import { summary } from "./fixtures";

const PASSWORD = "SecretPass1";
const CODE = "123456";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cognitoJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/x-amz-json-1.1" },
  });
}

function cognitoTarget(init?: RequestInit): string {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.["X-Amz-Target"] ?? "";
}

function cognitoBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function storageSnapshot(): string {
  const values: string[] = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key) {
      values.push(`${key}=${sessionStorage.getItem(key) ?? ""}`);
    }
  }
  try {
    values.push(`local=${JSON.stringify(localStorage)}`);
  } catch {
    // jsdom localStorage may be unavailable.
  }
  return values.join("\n");
}

function incompleteMe() {
  return {
    userId: "user_new",
    username: null,
    displayName: null,
    status: "ACTIVE",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
}

function completeMe() {
  return {
    userId: "user_seller",
    username: "seller",
    displayName: "Seller",
    status: "ACTIVE",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
}

function tokens() {
  return {
    AuthenticationResult: {
      AccessToken: "access-token",
      RefreshToken: "refresh-token",
      ExpiresIn: 3600,
    },
  };
}

describe("web account creation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("offers Create account on the sign-in screen with privacy and terms links", () => {
    render(<App />);
    expect(screen.getByRole("tab", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Development subject")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Development subject" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/new/privacy");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/new/terms");
  });

  it("rejects mismatched passwords before calling Cognito", async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: "NOT_FOUND", message: "missing" } }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Create account" }));
    await user.type(screen.getByLabelText("Email"), "alex@example.com");
    await user.type(screen.getByLabelText("Password", { exact: true }), PASSWORD);
    await user.type(screen.getByLabelText("Confirm password"), "DifferentPass1");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageSnapshot()).not.toContain(PASSWORD);
  });

  it("signs up through Cognito, then confirms, auto-signs-in, and opens first-run setup", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const target = cognitoTarget(init);
      if (target.endsWith(".SignUp")) {
        return cognitoJson({ UserConfirmed: false });
      }
      if (target.endsWith(".ConfirmSignUp")) {
        return cognitoJson({});
      }
      if (target.endsWith(".ResendConfirmationCode")) {
        return cognitoJson({});
      }
      if (target.endsWith(".InitiateAuth")) {
        return cognitoJson(tokens());
      }
      if (url.endsWith("/me") && !url.includes("/proofs") && !url.includes("/profile")) {
        return json(incompleteMe());
      }
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Create account" }));
    expect(screen.getByText(/agree to the PackProof/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Privacy Policy" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Terms of Service" }).length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Email"), "Alex@Example.com");
    await user.type(screen.getByLabelText("Password", { exact: true }), PASSWORD);
    await user.type(screen.getByLabelText("Confirm password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText("We sent a verification code to alex@example.com.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    const signUp = fetchMock.mock.calls.find((call) => cognitoTarget(call[1]).endsWith(".SignUp"));
    expect(signUp).toBeTruthy();
    expect(cognitoBody(signUp?.[1])).toMatchObject({
      Username: "alex@example.com",
      Password: PASSWORD,
      UserAttributes: [{ Name: "email", Value: "alex@example.com" }],
    });

    await user.click(screen.getByRole("button", { name: "Resend code" }));
    await screen.findByText("A new verification code was sent.");
    expect(fetchMock.mock.calls.some((call) => cognitoTarget(call[1]).endsWith(".ResendConfirmationCode"))).toBe(
      true,
    );

    await user.type(screen.getByLabelText("Verification code"), CODE);
    await user.click(screen.getByRole("button", { name: "Verify account" }));

    expect(await screen.findByRole("heading", { name: "Finish setting up your account" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => cognitoTarget(call[1]).endsWith(".ConfirmSignUp"))).toBe(true);
    expect(
      fetchMock.mock.calls.some((call) => {
        const body = cognitoBody(call[1]);
        return cognitoTarget(call[1]).endsWith(".InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH";
      }),
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/me"))).toBe(true);
    expect(storageSnapshot()).not.toContain(PASSWORD);
    expect(storageSnapshot()).not.toContain(CODE);
    const apiBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).includes("cognito-idp"))
      .map((call) => String(call[1]?.body ?? ""));
    expect(apiBodies.join("\n")).not.toContain(PASSWORD);
    expect(apiBodies.join("\n")).not.toContain(CODE);
  });

  it("maps Cognito sign-up errors for an existing email", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (cognitoTarget(init).endsWith(".SignUp")) {
        return cognitoJson({ __type: "UsernameExistsException", message: "User already exists" }, 400);
      }
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Create account" }));
    await user.type(screen.getByLabelText("Email"), "alex@example.com");
    await user.type(screen.getByLabelText("Password", { exact: true }), PASSWORD);
    await user.type(screen.getByLabelText("Confirm password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account already exists for this email. Sign in instead.",
    );
    expect(screen.queryByText("User already exists")).not.toBeInTheDocument();
  });

  it("lets an existing user sign in and enter the workspace", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (cognitoTarget(init).endsWith(".InitiateAuth")) {
        return cognitoJson(tokens());
      }
      if (url.endsWith("/me") && !url.includes("/proofs")) {
        return json(completeMe());
      }
      if (url.endsWith("/me/proofs")) {
        return json({ proofs: [summary] });
      }
      if (url.endsWith("/invitations")) {
        return json({ invitations: [] });
      }
      if (url.split("?")[0].endsWith("/me/marketplaces")) {
        return json({ marketplaces: [] });
      }
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("Email"), "seller@example.com");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findAllByText("Vintage camera")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Finish setting up your account" })).not.toBeInTheDocument();
    expect(storageSnapshot()).not.toContain(PASSWORD);
  });

  it("shows first-run setup for an authenticated user with a null profile", async () => {
    saveSession({
      apiBaseUrl: "",
      authMode: "cognito",
      userId: "user_new",
      username: null,
      displayName: null,
      token: "access-token",
      refreshToken: "refresh-token",
      accessExpiresAt: null,
      subject: "alex@example.com",
    });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Finish setting up your account" })).toBeInTheDocument();
    expect(screen.getByLabelText("PackProof username")).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed after you choose it/)).toBeInTheDocument();
    expect(screen.queryByText("Vintage camera")).not.toBeInTheDocument();
  });

  it("submits username and display name, then enters the workspace", async () => {
    saveSession({
      apiBaseUrl: "",
      authMode: "cognito",
      userId: "user_new",
      username: null,
      displayName: null,
      token: "access-token",
      refreshToken: "refresh-token",
      accessExpiresAt: null,
      subject: "alex@example.com",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me/profile") && init?.method === "PATCH") {
        return json({
          ...incompleteMe(),
          username: "alexproof",
          displayName: "Alex Proof",
        });
      }
      if (url.endsWith("/me/proofs")) {
        return json({ proofs: [summary] });
      }
      if (url.endsWith("/invitations")) {
        return json({ invitations: [] });
      }
      if (url.split("?")[0].endsWith("/me/marketplaces")) {
        return json({ marketplaces: [] });
      }
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("PackProof username"), "alexproof");
    await user.type(screen.getByLabelText("Display name"), "Alex Proof");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    expect((await screen.findAllByText("Vintage camera")).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/me/profile",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ username: "alexproof", displayName: "Alex Proof" }),
      }),
    );
  });

  it("presents USERNAME_TAKEN as an inline username error", async () => {
    saveSession({
      apiBaseUrl: "",
      authMode: "cognito",
      userId: "user_new",
      username: null,
      displayName: null,
      token: "access-token",
      refreshToken: null,
      accessExpiresAt: null,
      subject: "alex@example.com",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/me/profile") && init?.method === "PATCH") {
          return json({ error: { code: "USERNAME_TAKEN", message: "username is already taken" } }, 409);
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("PackProof username"), "seller");
    await user.type(screen.getByLabelText("Display name"), "Alex Proof");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That PackProof username is already taken. Try another.",
    );
    expect(screen.getByRole("heading", { name: "Finish setting up your account" })).toBeInTheDocument();
  });

  it("does not ask for a username that is already chosen", async () => {
    saveSession({
      apiBaseUrl: "",
      authMode: "cognito",
      userId: "user_new",
      username: "alexproof",
      displayName: null,
      token: "access-token",
      refreshToken: null,
      accessExpiresAt: null,
      subject: "alex@example.com",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me/profile") && init?.method === "PATCH") {
        return json({
          ...incompleteMe(),
          username: "alexproof",
          displayName: "Alex Proof",
        });
      }
      if (url.endsWith("/me/proofs")) {
        return json({ proofs: [] });
      }
      if (url.endsWith("/invitations")) {
        return json({ invitations: [] });
      }
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/@alexproof/)).toBeInTheDocument();
    expect(screen.queryByLabelText("PackProof username")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Display name"), "Alex Proof");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => {
      expect(screen.getByText(/No Proofs to show yet/)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/me/profile",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "Alex Proof" }),
      }),
    );
  });
});
