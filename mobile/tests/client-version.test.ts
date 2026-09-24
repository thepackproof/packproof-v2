import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createClientVersionReporter,
  installedClientVersion,
  type ClientVersion,
} from "../src/analytics/client-version.ts";
import { PackProofV2Client } from "../src/v2-api.ts";

const native = {
  platform: "android", development: false, executionEnvironment: "bare",
  nativeApplicationVersion: "1.0.1", nativeBuildVersion: "54",
};
const release: ClientVersion = { platform: "ANDROID", version: "1.0.1", build: "54" };
const session = { userId: "user_one", apiBaseUrl: "https://api.example.test/", token: "fixture-token" };

test("only installed native release numbers are reported, with unknown builds omitted", () => {
  const source = { ...native, expoConfig: { version: "9.9.9" }, packageVersion: "0.1.0", deviceId: "private" };
  assert.deepEqual(installedClientVersion(source), release);
  assert.deepEqual(installedClientVersion({ ...source, platform: "ios", nativeBuildVersion: "1.2.3" }),
    { platform: "IOS", version: "1.0.1", build: "1.2.3" });
  for (const nativeBuildVersion of [null, undefined, "unknown", "", 54, "private-device-id"]) {
    assert.deepEqual(installedClientVersion({ ...source, nativeBuildVersion }), { platform: "ANDROID", version: "1.0.1" });
  }
  for (const nativeApplicationVersion of [null, undefined, "", "unknown", "0", "a".repeat(49)]) {
    assert.equal(installedClientVersion({ ...source, nativeApplicationVersion }), null, "must never fall back to app config or package version");
  }
  for (const override of [{ development: true }, { executionEnvironment: "storeClient" }, { executionEnvironment: "unknown" }, { platform: "web" }]) {
    assert.equal(installedClientVersion({ ...native, ...override }), null);
  }
});

function fixture(send: (version: ClientVersion) => Promise<void> = async () => undefined) {
  const reports: Array<{ userId: string; value: ClientVersion }> = [];
  let currentUser = session.userId;
  const client = {
    apiBaseUrl: "https://api.example.test",
    assertCaptureAccount(userId: string, apiBaseUrl: string) {
      assert.equal(userId, currentUser);
      assert.equal(apiBaseUrl, client.apiBaseUrl);
    },
    reportClientVersion(value: ClientVersion) {
      reports.push({ userId: currentUser, value });
      return send(value);
    },
  };
  return { client, reports, reporter: createClientVersionReporter(() => release), switchUser: (userId: string) => { currentUser = userId; } };
}

test("reporting requires a signed-in unexpired account matching the active API and account", () => {
  const f = fixture();
  for (const value of [null, { ...session, token: "" }, { ...session, needsReauthentication: true },
    { ...session, accessExpiresAt: Date.now() - 1 }, { ...session, apiBaseUrl: "https://other.example.test" },
    { ...session, userId: "stale-user" }]) {
    assert.doesNotThrow(() => f.reporter.update(value, f.client));
  }
  assert.equal(f.reports.length, 0);
  f.reporter.update(session, f.client);
  assert.deepEqual(f.reports, [{ userId: "user_one", value: release }]);
});

test("token refresh and repeated state updates do not report again, but account and session changes do", () => {
  const f = fixture(() => new Promise(() => {}));
  assert.equal(f.reporter.update(session, f.client), undefined, "telemetry must not return a promise for authentication to await");
  f.reporter.update({ ...session, token: "refreshed-token" }, f.client);
  f.reporter.update({ ...session, apiBaseUrl: "https://api.example.test" }, f.client);
  assert.equal(f.reports.length, 1);
  f.switchUser("user_two");
  f.reporter.update({ ...session, userId: "user_two" }, f.client);
  assert.equal(f.reports.length, 2);
  f.reporter.update(null, f.client);
  f.reporter.update({ ...session, userId: "user_two" }, f.client);
  assert.equal(f.reports.length, 3);
  f.client.apiBaseUrl = "https://second-api.example.test";
  f.reporter.update({ ...session, userId: "user_two", apiBaseUrl: f.client.apiBaseUrl }, f.client);
  assert.equal(f.reports.length, 4);
});

test("offline, old-server, native-module and synchronous failures are silent and bounded", async () => {
  for (const send of [async () => { throw new Error("offline or HTTP 404"); }, () => { throw new Error("sync error"); }]) {
    const f = fixture(send);
    assert.doesNotThrow(() => f.reporter.update(session, f.client));
    await new Promise<void>(resolve => setImmediate(resolve));
    f.reporter.update({ ...session, token: "refreshed" }, f.client);
    assert.equal(f.reports.length, 1);
  }
  for (const read of [() => null, () => { throw new Error("native module missing"); }]) {
    let reads = 0;
    const f = fixture();
    const reporter = createClientVersionReporter(() => { reads++; return read(); });
    assert.doesNotThrow(() => reporter.update(session, f.client));
    reporter.update(session, f.client);
    assert.equal(reads, 1);
    assert.equal(f.reports.length, 0);
  }
});

test("client version uses the authenticated canonical endpoint and sends only release metadata", async () => {
  const requests: Array<{ method: string; url: string; body: unknown; authorization: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push({ method: req.method!, url: req.url!, body: JSON.parse(body), authorization: req.headers.authorization ?? "" });
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new PackProofV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, getToken: () => "fixture-token" });
  try {
    const input = { ...release, userId: "private-user", deviceId: "private-device", refreshToken: "private-token" };
    await client.reportClientVersion(input);
    await client.reportClientVersion({ platform: "IOS", version: "1.0.1" });
    assert.deepEqual(requests, [
      { method: "POST", url: "/me/client-version", body: release, authorization: "Bearer fixture-token" },
      { method: "POST", url: "/me/client-version", body: { platform: "IOS", version: "1.0.1" }, authorization: "Bearer fixture-token" },
    ]);
    const signedOut = new PackProofV2Client({ baseUrl: client.apiBaseUrl, getToken: () => null });
    await assert.rejects(signedOut.reportClientVersion(release), /Missing bearer token/);
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("version reporting aborts after five seconds even if the transport ignores cancellation", async (t) => {
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", (_input: unknown, options: RequestInit) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new PackProofV2Client({ baseUrl: "https://api.example.test", getToken: () => "fixture-token" });
  const request = client.reportClientVersion(release);
  const rejected = assert.rejects(request, { code: "REQUEST_TIMEOUT" });
  t.mock.timers.tick(5_000);
  await rejected;
  assert.equal(signal?.aborted, true);
});
