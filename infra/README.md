# PackProof V2 AWS staging infrastructure

CloudFormation in this directory:

- `staging.yaml` — VPC, RDS PostgreSQL, ECS cluster, IAM roles, CodeBuild
- `api-service.yaml` — ECS Express Mode / Fargate API
- `web.yaml` — S3 + CloudFront reference client

Deploy with `deploy.ps1` / `deploy-web.ps1`.

## Task role vs execution role

The API process uses the AWS SDK inside the container (S3 evidence, Secrets Manager for trusted integrations). Those calls use the **task role** (`packproof-v2-staging-task`, parameter `TaskRoleArn`).

The **task execution role** (`packproof-v2-staging-execution`) is for the ECS agent: image pull, CloudWatch logs, and injecting the RDS username/password from Secrets Manager into the task definition. It must not be used as the application credential role for EasyPost.

Staging integration secrets are readable only by the task role:

`arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:packproof/staging/integrations/*`

Secret **values** are never CloudFormation outputs. `DatabaseSecretArn` is an ARN, not a password.

`deploy.ps1` applies the API through the ECS Express Mode CLI, not by updating `api-service.yaml` in place. The script must set `PACKPROOF_CREDENTIAL_STORE=secrets-manager` on the container. The task role IAM update still comes from `cloudformation deploy` of `staging.yaml`.

See [EASYPOST_TRACKING_INTEGRATION.md](../docs/EASYPOST_TRACKING_INTEGRATION.md).
