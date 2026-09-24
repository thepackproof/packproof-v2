import { afterEach, describe, expect, it, vi } from "vitest";
import { DescribeAlarmsCommand, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { awsTelemetry, type AwsTelemetryOptions } from "../src/admin/aws-telemetry.js";

const now = new Date("2026-09-24T12:03:00.000Z");
const clock = { now: () => now };
const environment = {
  PACKPROOF_ADMIN_AWS_REGION: "us-west-2",
  PACKPROOF_ADMIN_ALB_DIMENSION: "app/packproof/0123456789abcdef",
  PACKPROOF_ADMIN_ECS_CLUSTER: "packproof-cluster",
  PACKPROOF_ADMIN_ECS_SERVICE: "packproof-api",
  PACKPROOF_ADMIN_RDS_INSTANCE: "packproof-db",
  PACKPROOF_ADMIN_S3_BUCKET: "packproof-evidence",
  PACKPROOF_ADMIN_CLOUDFRONT_DISTRIBUTION: "EDISTRIBUTION123",
};
const costEnvironment = {
  PACKPROOF_ADMIN_COSTS_ENABLED: "true",
  PACKPROOF_ADMIN_COST_LINKED_ACCOUNT: "123456789012",
};

function observations(command: GetMetricDataCommand) {
  return { MetricDataResults: command.input.MetricDataQueries!.map((query) => {
    const stat = query.MetricStat!;
    const name = stat.Metric!.MetricName!;
    const value = name === "TargetResponseTime" ? 0.25 : name === "RequestCount" ? 100 : name === "HTTPCode_Target_4XX_Count" ? 5 : name === "HTTPCode_Target_5XX_Count" ? 0 : 10;
    return { Id: query.Id, StatusCode: "Complete", Values: [value], Timestamps: [new Date(command.input.EndTime!.getTime() - stat.Period! * 1000)] };
  }) };
}

function costsFor(command: GetCostAndUsageCommand) {
  const { Start, End } = command.input.TimePeriod!;
  const rows = [];
  for (let time = Date.parse(Start!); time < Date.parse(End!); time += 86_400_000) {
    rows.push({ TimePeriod: { Start: new Date(time).toISOString().slice(0, 10), End: new Date(time + 86_400_000).toISOString().slice(0, 10) }, Estimated: true, Total: { UnblendedCost: { Amount: "1.25", Unit: "USD" } } });
  }
  return { ResultsByTime: rows };
}

const metric = (result: Awaited<ReturnType<typeof awsTelemetry>>, key: string) => result.metrics.find((row) => row.key === key)!;

afterEach(() => vi.useRealTimers());

describe("AWS admin telemetry", () => {
  it("does not make any AWS request when explicit resource configuration is absent", async () => {
    const send = vi.fn();
    const result = await awsTelemetry({ env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "SECRET_ID", DATABASE_URL: "SECRET_DATABASE" }, clock, cloudWatchClient: { send }, costExplorerClient: { send } });
    expect(send).not.toHaveBeenCalled();
    expect(result.metrics.every((row) => row.value === null && row.status === "unavailable")).toBe(true);
    expect(result.services.every((row) => row.status === "unavailable")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("uses scoped AWS dimensions and correct statistics, periods and target error denominators", async () => {
    const send = vi.fn(async (command: GetMetricDataCommand | DescribeAlarmsCommand) => {
      expect(command).toBeInstanceOf(GetMetricDataCommand);
      return observations(command as GetMetricDataCommand);
    });
    const result = await awsTelemetry({ env: environment, clock, cloudWatchClient: { send } });
    expect(send).toHaveBeenCalledTimes(3);
    const commands = send.mock.calls.map(([command]) => command as GetMetricDataCommand);
    const queries = commands.flatMap((command) => command.input.MetricDataQueries!);
    const query = (namespace: string, name: string) => queries.find((entry) => entry.MetricStat?.Metric?.Namespace === namespace && entry.MetricStat.Metric.MetricName === name)!.MetricStat!;
    expect(query("AWS/ApplicationELB", "TargetResponseTime")).toMatchObject({ Stat: "p95", Period: 300, Metric: { Dimensions: [{ Name: "LoadBalancer", Value: environment.PACKPROOF_ADMIN_ALB_DIMENSION }] } });
    expect(query("AWS/ECS", "CPUUtilization").Metric!.Dimensions).toEqual([{ Name: "ClusterName", Value: "packproof-cluster" }, { Name: "ServiceName", Value: "packproof-api" }]);
    expect(query("AWS/RDS", "FreeStorageSpace").Metric!.Dimensions).toEqual([{ Name: "DBInstanceIdentifier", Value: "packproof-db" }]);
    expect(query("AWS/S3", "BucketSizeBytes")).toMatchObject({ Stat: "Average", Period: 86400, Metric: { Dimensions: [{ Name: "BucketName", Value: "packproof-evidence" }, { Name: "StorageType", Value: "StandardStorage" }] } });
    expect(query("AWS/S3", "NumberOfObjects").Metric!.Dimensions).toContainEqual({ Name: "StorageType", Value: "AllStorageTypes" });
    expect(query("AWS/CloudFront", "4xxErrorRate")).toMatchObject({ Stat: "Average", Metric: { Dimensions: [{ Name: "DistributionId", Value: "EDISTRIBUTION123" }, { Name: "Region", Value: "Global" }] } });
    expect(query("AWS/CloudFront", "BytesDownloaded").Stat).toBe("Sum");
    expect(metric(result, "apiLatencyP95")).toMatchObject({ value: 250, unit: "ms", status: "available" });
    expect(metric(result, "apiLatencyP95").note).toContain("2026-09-24T11:55:00.000Z");
    expect(metric(result, "apiTarget4xxRate").value).toBe(5);
    expect(metric(result, "apiTarget5xxRate").value).toBe(0);
    expect(metric(result, "s3BucketBytes").note).toContain("StandardStorage only");
    expect(metric(result, "s3BucketBytes").note).toContain("2026-09-23T00:00:00.000Z");
    expect(result.services.every((row) => row.status !== "healthy")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("packproof-evidence");
    for (const [, options] of send.mock.calls as unknown as Array<[unknown, { abortSignal: AbortSignal }]>) expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("requires both ECS dimensions and never falls back to an invalid or broad resource", async () => {
    const send = vi.fn();
    const result = await awsTelemetry({ env: {
      PACKPROOF_ADMIN_AWS_REGION: "us-east-1", PACKPROOF_ADMIN_ECS_CLUSTER: "only-cluster",
      PACKPROOF_ADMIN_ALB_DIMENSION: "*", PACKPROOF_ADMIN_RDS_INSTANCE: "https://secret.invalid",
    }, clock, cloudWatchClient: { send } });
    expect(send).not.toHaveBeenCalled();
    expect(result.metrics.every((row) => row.value === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });

  it("keeps absent, partial, stale and invalid datapoints unavailable while preserving observed zero", async () => {
    const send = vi.fn(async (command: GetMetricDataCommand | DescribeAlarmsCommand) => {
      const response = observations(command as GetMetricDataCommand);
      const rows = response.MetricDataResults;
      rows[0]!.Values = [];
      rows[1]!.StatusCode = "PartialData";
      rows[2]!.Timestamps = [new Date("2026-09-20T00:00:00Z")];
      rows[3]!.Values = [0];
      rows[4]!.Values = [NaN];
      rows[5]!.Timestamps = [new Date("2026-09-25T00:00:00Z")];
      return response;
    });
    const result = await awsTelemetry({ env: { PACKPROOF_ADMIN_AWS_REGION: "us-east-1", PACKPROOF_ADMIN_ALB_DIMENSION: environment.PACKPROOF_ADMIN_ALB_DIMENSION }, clock, cloudWatchClient: { send } });
    for (const key of ["apiLatencyP95", "apiRequests", "apiTarget4xx", "apiLoadBalancer4xx", "apiLoadBalancer5xx", "apiTarget4xxRate", "apiTarget5xxRate"]) expect(metric(result, key).value).toBeNull();
    expect(metric(result, "apiTarget5xx").value).toBe(0);
  });

  it("does not derive rates from different intervals or zero request denominators", async () => {
    const send = vi.fn(async (command: GetMetricDataCommand | DescribeAlarmsCommand) => {
      const result = observations(command as GetMetricDataCommand);
      result.MetricDataResults[2]!.Timestamps = [new Date("2026-09-24T11:50:00Z")];
      return result;
    });
    const env = { PACKPROOF_ADMIN_AWS_REGION: "us-east-1", PACKPROOF_ADMIN_ALB_DIMENSION: environment.PACKPROOF_ADMIN_ALB_DIMENSION };
    const result = await awsTelemetry({ env, clock, cloudWatchClient: { send } });
    expect(metric(result, "apiTarget4xxRate").value).toBeNull();
    send.mockImplementationOnce(async (command) => {
      const response = observations(command as GetMetricDataCommand);
      response.MetricDataResults[1]!.Values = [0];
      return response;
    });
    const zero = await awsTelemetry({ env, clock, cloudWatchClient: { send } });
    expect(metric(zero, "apiTarget5xxRate").value).toBeNull();
  });

  it("redacts AWS failures, labels and messages, and rejects truncated metric pages", async () => {
    const send = vi.fn(async () => { throw new Error("SECRET_SESSION_TOKEN secret-bucket internal-endpoint"); });
    const failed = await awsTelemetry({ env: environment, clock, cloudWatchClient: { send } });
    expect(failed.metrics.every((row) => row.value === null)).toBe(true);
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|secret-bucket|internal-endpoint/);
    const partial = await awsTelemetry({ env: environment, clock, cloudWatchClient: { send: async () => ({ NextToken: "SECRET_NEXT_PAGE", Messages: [{ Value: "SECRET_MESSAGE" }], MetricDataResults: [{ Id: "m0", Label: "SECRET_LABEL", StatusCode: "Complete", Values: [42], Timestamps: [new Date("2026-09-24T11:55:00Z")] }] }) } });
    expect(partial.metrics.every((row) => row.value === null)).toBe(true);
    expect(JSON.stringify(partial)).not.toContain("SECRET");
  });

  it("aborts a hanging read after four seconds even if an injected client ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const cloudWatchClient: AwsTelemetryOptions["cloudWatchClient"] = { send: async (_command, options) => {
      signal = options.abortSignal;
      return new Promise(() => undefined);
    } };
    const pending = awsTelemetry({ env: { PACKPROOF_ADMIN_AWS_REGION: "us-east-1", PACKPROOF_ADMIN_RDS_INSTANCE: "packproof-db" }, clock, cloudWatchClient });
    await vi.advanceTimersByTimeAsync(4000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(metric(result, "rdsCpu").value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only reports configured alarms healthy when every named alarm is present and OK", async () => {
    const env = { PACKPROOF_ADMIN_AWS_REGION: "us-east-1", PACKPROOF_ADMIN_CLOUDWATCH_ALARMS: "packproof-api-errors,packproof-capacity" };
    const send = vi.fn(async (command: GetMetricDataCommand | DescribeAlarmsCommand) => {
      expect(command).toBeInstanceOf(DescribeAlarmsCommand);
      expect(command.input).toMatchObject({ AlarmNames: ["packproof-api-errors", "packproof-capacity"], AlarmTypes: ["MetricAlarm", "CompositeAlarm"] });
      return { MetricAlarms: [{ AlarmName: "packproof-api-errors", StateValue: "OK", StateReason: "SECRET_REASON" }], CompositeAlarms: [{ AlarmName: "packproof-capacity", StateValue: "OK" }] };
    });
    const result = await awsTelemetry({ env, clock, cloudWatchClient: { send } });
    expect(result.services.find((row) => row.key === "aws-alarms")?.status).toBe("healthy");
    expect(JSON.stringify(result)).not.toContain("SECRET_REASON");
    for (const state of ["ALARM", "INSUFFICIENT_DATA", "MISSING"]) {
      const value = await awsTelemetry({ env, clock, cloudWatchClient: { send: async () => ({ MetricAlarms: state === "MISSING" ? [] : [{ AlarmName: "packproof-api-errors", StateValue: state }] }) } });
      expect(value.services.find((row) => row.key === "aws-alarms")?.status).toBe(state === "ALARM" ? "warning" : "unavailable");
    }
  });

  it("restricts Cost Explorer to the allowlisted account/tag, discloses estimates and caches reads", async () => {
    const send = vi.fn(async (command: GetCostAndUsageCommand) => {
      expect(command).toBeInstanceOf(GetCostAndUsageCommand);
      expect(command.input).toEqual({
        TimePeriod: { Start: "2026-09-01", End: "2026-09-24" }, Granularity: "DAILY", Metrics: ["UnblendedCost"],
        Filter: { And: [{ Dimensions: { Key: "LINKED_ACCOUNT", Values: ["123456789012"] } }, { Tags: { Key: "Application", Values: ["PackProof"], MatchOptions: ["EQUALS"] } }] },
      });
      return costsFor(command);
    });
    const options = { env: { ...costEnvironment, PACKPROOF_ADMIN_COST_TAG_KEY: "Application", PACKPROOF_ADMIN_COST_TAG_VALUE: "PackProof" }, clock, costExplorerClient: { send } };
    const [result, concurrent] = await Promise.all([awsTelemetry(options), awsTelemetry(options)]);
    expect(metric(result, "awsCost")).toMatchObject({ value: 28.75, unit: "USD", status: "available" });
    expect(metric(result, "awsCost").note).toContain("AWS marks some costs estimated");
    expect(metric(result, "awsCost").note).toContain("through 2026-09-24 exclusive");
    expect(metric(result, "awsCost").note).toContain("Retrieved 2026-09-24T12:03:00.000Z");
    expect(metric(concurrent, "awsCost")).toEqual(metric(result, "awsCost"));
    await awsTelemetry(options);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("123456789012");
  });

  it("refreshes the billing cache after six hours and on a new UTC coverage day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const send = vi.fn(async (command: GetCostAndUsageCommand) => costsFor(command));
    const options = { env: costEnvironment, costExplorerClient: { send }, clock: { now: () => new Date() } };
    await awsTelemetry(options);
    await vi.advanceTimersByTimeAsync(6 * 3_600_000 - 1);
    await awsTelemetry(options);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await awsTelemetry(options);
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
    await awsTelemetry(options);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("never reads unscoped costs or falls back from an invalid tag, and skips month day one", async () => {
    const send = vi.fn();
    for (const env of [{ PACKPROOF_ADMIN_COSTS_ENABLED: "true" }, { ...costEnvironment, PACKPROOF_ADMIN_COST_TAG_KEY: "Application" }]) {
      const result = await awsTelemetry({ env, clock, costExplorerClient: { send } });
      expect(metric(result, "awsCost").value).toBeNull();
    }
    const first = await awsTelemetry({ env: costEnvironment, clock: { now: () => new Date("2026-10-01T23:59:59Z") }, costExplorerClient: { send } });
    expect(metric(first, "awsCost").note).toContain("No completed UTC day");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects missing billing days, pagination, currency mismatch and raw provider errors", async () => {
    for (const mode of ["missing", "pagination", "currency", "error"]) {
      const send = async (command: GetCostAndUsageCommand) => {
        if (mode === "error") throw new Error("SECRET_BILLING_ERROR");
        const output = costsFor(command);
        if (mode === "missing") output.ResultsByTime.pop();
        if (mode === "currency") output.ResultsByTime[0]!.Total.UnblendedCost.Unit = "SECRET_CURRENCY";
        return { ...output, ...(mode === "pagination" ? { NextPageToken: "SECRET_PAGE" } : {}) };
      };
      const result = await awsTelemetry({ env: costEnvironment, clock, costExplorerClient: { send } });
      expect(metric(result, "awsCost").value).toBeNull();
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });
});
