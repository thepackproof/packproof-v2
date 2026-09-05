# PackProof V2 AWS staging infrastructure

CloudFormation in this directory:

- `staging.yaml` — VPC, RDS PostgreSQL, ECS cluster, IAM roles, CodeBuild
- `api-service.yaml` — ECS Express Mode / Fargate API
- `web.yaml` — S3 + CloudFront reference client

Deploy matching API and web builds with `deploy-staging-current.ps1`. `deploy.ps1` and `deploy-web.ps1` also support separate deployments.

## Task role vs execution role

The API process uses the AWS SDK inside the container (S3 evidence, Secrets Manager for trusted integrations). Those calls use the **task role** (`packproof-v2-staging-task`, parameter `TaskRoleArn`).

The **task execution role** (`packproof-v2-staging-execution`) is for the ECS agent: image pull, CloudWatch logs, and injecting the RDS username/password from Secrets Manager into the task definition. It must not be used as the application credential role for EasyPost.

Staging integration secrets are readable and writable only by the task role, on this namespace:

`arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:packproof/staging/integrations/*`

Allowed actions: `GetSecretValue`, `CreateSecret`, `PutSecretValue`, `DeleteSecret`. That covers the existing EasyPost secret, the eBay app secret `packproof/staging/integrations/ebay/app`, and per-connection eBay user tokens `packproof/staging/integrations/ebay/sandbox/<connectionId>`. The execution role must not use this namespace.

Optional Sandbox eBay enablement is a `deploy.ps1` switch (`-EnableEbay`). It sets `PACKPROOF_EBAY_*` environment variables except the Cert ID. The application secret is resolved at runtime from `PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE` (Secrets Manager), never from ECS plaintext.

Secret **values** are never CloudFormation outputs. `DatabaseSecretArn` is an ARN, not a password.

`deploy.ps1` applies the API through the ECS Express Mode CLI, not by updating `api-service.yaml` in place. The script must set `PACKPROOF_CREDENTIAL_STORE=secrets-manager` on the container, pass `PACKPROOF_RELEASE_SHA` / `PACKPROOF_RELEASE_IMAGE` for `GET /meta`, and wait until every running task uses the new image. The task role IAM update still comes from `cloudformation deploy` of `staging.yaml`.

See [EASYPOST_TRACKING_INTEGRATION.md](../docs/EASYPOST_TRACKING_INTEGRATION.md).

## Release validation and rollout behavior

The staging workflow waits for successful `CI` on the exact main commit before configuring AWS credentials or changing resources. CI includes real PostgreSQL migration concurrency and PowerShell deployment regression checks. Changes to shared mobile copy, station, and theme files also trigger web deployment, and the deployment runner installs those shared dependencies.

`deploy.ps1` merges existing optional runtime settings and secret references with explicit deployment settings before submitting the new image. Notification secret references are included in that same rollout. Explicit deployment settings win and a name cannot appear as both plaintext environment and secret. Secret values are never fetched by this process. Web deployment avoids updating CORS when the value already matches.

The Express canary deployment can take longer than the generic ECS waiter's ten-minute budget. The shared waiter allows thirty minutes, checks the exact running image and task definition, and requires a completed primary rollout. Failure prints service events and stopped task status without dumping container environment or credentials. A configuration-only web update also waits for its new task definition. These checks verify ECS convergence; the workflow then verifies public API `/meta` and the published web content.

Each web build publishes `release.json` with the commit, target API, and SHA-256 hashes of the index and assets. CloudFront invalidation must complete before verification compares the served files to these hashes. Previous hashed assets remain available for open browser tabs during rollout; deploy does not delete them while old pages can still reference them.

Run local deployment regression checks (no AWS access):

```powershell
./infra/tests/deployment-helpers.test.ps1
```

A September 5, 2026 delivery audit found that the prior workflow's second, redundant configuration rollout exceeded its waiter, then completed about one minute later. The API was healthy, but web deployment had already been skipped. A failed workflow therefore does not by itself identify an unhealthy API; inspect the service events and public release identity before recovery.
