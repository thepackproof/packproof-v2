# AWS observations in the admin dashboard

The Infrastructure page can read scoped CloudWatch metrics, configured alarm
states, and Cost Explorer totals. These adapters are optional. Missing settings,
missing datapoints, access denial, incomplete responses, and timeouts produce
explicit unavailable values. They never become zero traffic, zero costs, or
healthy infrastructure.

The implementation does not discover resources, modify AWS configuration,
create alarms, or grant permissions. Deployment still requires verification of
the actual resource selectors and the runtime role's existing read permissions.
No live AWS access or IAM change is implied by this code.

## Runtime configuration

Set these environment variables on the backend after verifying the intended
resources. All selectors are validated; no selector is accepted from an admin
HTTP query. Omit any source that should remain unconfigured.

| Variable | Meaning |
| --- | --- |
| `PACKPROOF_ADMIN_AWS_REGION` | Region for ALB, ECS, RDS, S3, and configured alarms, such as `us-east-1`. This is explicit and does not default to an unrelated runtime region. |
| `PACKPROOF_ADMIN_ALB_DIMENSION` | Exact CloudWatch load-balancer dimension, `app/<name>/<16 lowercase hexadecimal characters>`; not a full ARN or hostname. |
| `PACKPROOF_ADMIN_ECS_CLUSTER` | Exact ECS cluster name. Requires the service setting below. |
| `PACKPROOF_ADMIN_ECS_SERVICE` | Exact ECS service name. |
| `PACKPROOF_ADMIN_RDS_INSTANCE` | Exact DB instance identifier. |
| `PACKPROOF_ADMIN_S3_BUCKET` | Exact bucket whose daily metrics should be read. |
| `PACKPROOF_ADMIN_CLOUDFRONT_DISTRIBUTION` | Exact distribution ID. Its CloudWatch reads always use `us-east-1` and `Region=Global`. |
| `PACKPROOF_ADMIN_CLOUDWATCH_ALARMS` | Optional comma-separated allowlist of up to 20 existing alarm names. Metric and composite alarms are supported. |
| `PACKPROOF_ADMIN_COSTS_ENABLED` | Set exactly `true` to enable Cost Explorer. |
| `PACKPROOF_ADMIN_COST_LINKED_ACCOUNT` | Required 12-digit account filter for cost queries. |
| `PACKPROOF_ADMIN_COST_TAG_KEY` | Optional cost allocation tag key. Requires a corresponding tag value. |
| `PACKPROOF_ADMIN_COST_TAG_VALUE` | Optional exact tag value. An invalid or incomplete tag filter does not fall back to broader account costs. |

The AWS SDK uses its default credential provider chain, including the deployed
task role. Do not add access keys or secret values to these selectors or to the
dashboard. The adapter never returns resource identifiers, credentials, raw AWS
exceptions, alarm descriptions, or alarm reason strings.

The runtime needs the applicable read operations:

- `cloudwatch:GetMetricData` for metrics.
- `cloudwatch:DescribeAlarms` when an alarm allowlist is configured.
- `ce:GetCostAndUsage` when cost collection is enabled.

Apply the service's IAM action and resource constraints through the existing
deployment process. Query selectors are an additional application boundary;
they do not replace IAM. Cost Explorer must also be available to that account
and role. Cost reads may incur AWS API charges; the cache limits repeated reads.

## Meaning and freshness

The admin page caches AWS snapshots for 30 seconds. AWS reads run independently
of local database/storage/worker probes and have a four-second deadline with
request cancellation and at most one retry. The overview does not wait for AWS
telemetry.

Traffic and capacity metrics use the most recent complete five-minute interval
within a 15-minute lookback. The displayed metric note includes its timestamp.
The ALB p95 metric measures target response-header latency, excluding client
network time. Target-generated and load-balancer-generated error counts remain
separate. Missing error datapoints are unavailable, even when AWS omits a metric
because no errors occurred.

ECS reports service CPU and memory. RDS reports CPU, connections, and free
storage. CloudFront reports requests, error percentages, and downloaded bytes.
Utilization values establish observations, not complete resource health. The
configured alarm row is healthy only when every allowlisted alarm is returned
with an `OK` state; `ALARM`, missing alarms, and insufficient data remain visible.
This covers the configured alarm thresholds and does not establish that every
service function works.

S3 metrics are delayed daily observations with a three-day lookback. The byte
metric explicitly covers `StandardStorage`, excluding other storage classes.
The `AllStorageTypes` object-count metric includes versions, delete markers, and
incomplete multipart parts for general-purpose buckets. The existing metadata
probe checks one committed object separately and downloads no evidence bytes.

Cost Explorer reads daily `UnblendedCost` from the first day of the current UTC
month through the last completed UTC day. It does not forecast or estimate
today's missing costs. Successful results are cached for up to six hours;
failed reads are retried after the short snapshot interval. The metric states
its query period, retrieval time, scope, and whether AWS marked any day as
estimated. AWS does not return a billing refresh timestamp in this response.
Without a cost allocation tag, the value is account-wide across all services
and is not attributed solely to PackProof.

## AWS reference definitions

- [Application Load Balancer metrics](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html)
- [ECS CloudWatch metrics](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/available-metrics.html)
- [RDS CloudWatch metrics](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html)
- [S3 metrics and dimensions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html)
- [CloudFront monitoring](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/monitoring-using-cloudwatch.html)
- [CloudWatch GetMetricData](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html)
- [Cost Explorer GetCostAndUsage](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html)
