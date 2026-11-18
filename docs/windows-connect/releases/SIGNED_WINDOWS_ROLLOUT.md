# Publish PackProof Connect for Windows

Use the existing downloads distribution and the protected Connect signing and publishing environments. An internal development installer can exercise local folders and samples while the hosted rollout or signing account is pending. Its development service, pipe, data directory and credential scope are separate from a production install.

## Prepare the existing distribution

The `packproof-desktop-updates` stack in `us-east-1` already owns the downloads domain, private versioned bucket, and CloudFront distribution. Create an UPDATE change set from `infra/desktop-distribution/distribution.yaml` and retain the stack's existing parameter values, including the active domain. The change adds two channel-specific roles, two outputs, read access for the Connect paths from that distribution, and an uncached Connect update feed. Review the change set for resource replacement before executing it. The existing desktop publisher keeps its own paths.

For example, from the repository root with the authorized stack operator account:

```sh
aws cloudformation create-change-set --region us-east-1 \
  --stack-name packproof-desktop-updates --change-set-name connect-release-paths \
  --change-set-type UPDATE --capabilities CAPABILITY_IAM \
  --template-body file://infra/desktop-distribution/distribution.yaml \
  --parameters ParameterKey=DownloadsDomain,UsePreviousValue=true \
    ParameterKey=CertificateArn,UsePreviousValue=true \
    ParameterKey=ActivateDownloadsDomain,UsePreviousValue=true \
    ParameterKey=GitHubRepositorySubject,UsePreviousValue=true \
    ParameterKey=GitHubImmutableRepositorySubject,UsePreviousValue=true
aws cloudformation describe-change-set --region us-east-1 \
  --stack-name packproof-desktop-updates --change-set-name connect-release-paths
```

Use `ReleaseBucketName` and the matching `ConnectProductionPublishRoleArn` or `ConnectStagingPublishRoleArn` outputs when configuring GitHub. Protect the production environments for the main branch and use existing signing-credential administration.

| Environment | Required configuration |
| --- | --- |
| `connect-production` | `PACKPROOF_API_BASE_URL`, `PACKPROOF_WEB_BASE_URL`, `WINDOWS_PUBLISHER_NAME` and the authorized timestamped Windows signer. For PFX signing, configure protected `WINDOWS_CERTIFICATE_P12` and `WINDOWS_CERTIFICATE_PASSWORD`. For Azure, set `PACKPROOF_WINDOWS_SIGNING_PROVIDER=azure` and the tenant, client, subscription, signing endpoint, account and profile variables named in the workflow. |
| `connect-production-publish` | The same two protected origins, `PACKPROOF_RELEASE_BUCKET` and `PACKPROOF_RELEASE_ROLE_ARN` from the stack. |
| Staging | Use `connect-staging` and `connect-staging-publish` with the qualified staging origins, signer and staging publish role. |

The existing customer-facing portal origin is `https://dvpmnwc27i8tw.cloudfront.net` and the API origin is `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`. A signed build verifies both origins at the reviewed commit, including the Cognito portal and the multi-source browser approval route. The desktop update origin is `https://downloads.thepackproof.com`.

### Configure GitHub production environments

Run these commands from the repository root using an authenticated GitHub administrator CLI session and an AWS profile that can describe the downloads stack. The first command previews the setup. The second applies the environment settings.

```sh
node infra/desktop-distribution/configure-connect-environments.mjs
node infra/desktop-distribution/configure-connect-environments.mjs --apply
```

On creation, the helper uses the required reviewers, self-review rule, wait timer and administrator-bypass policy from the corresponding `desktop-production` or `desktop-production-publish` environment. It permits only the `main` branch and keeps existing Connect review protections. An existing environment with other deployment branches needs a manual branch-policy review in GitHub Settings before the helper proceeds. The helper sets the public portal/API origins, reads the bucket from the current stack, and sets the publisher role from `ConnectProductionPublishRoleArn`. If the change set is still pending, it reports exit status 2. Rerun after the stack update to finish. Repeating the command retains matching settings.

Configure your authorized signer separately in `connect-production` using the signing administrator’s protected PFX secrets or Azure signing identity listed above. The helper never opens signing secrets, reads credentials from another environment, or prints credential values.

## Build and promote the same bytes

1. Complete the coordinated backend and portal deployment. Run **Connect Windows candidate** on the reviewed main commit. The workflow supports a manual run at main if the file changes did not trigger it.
2. Dispatch **Connect signed Windows release** at that commit with `operation=build`, `channel=production` and `reviewed_sha` set to the full commit. The protected job signs the package and verifies its Authenticode publisher, timestamp, native components, update metadata, application assets and packaged screens. Download the signed candidate from its Actions artifact.
3. Record the signed run ID, installer SHA-256 and signed Windows acceptance results. Use the existing multisource acceptance checklist for the real Windows install, upgrade, reboot, organization approval and fresh Proof under the intended cohort. Keep customer data in its authorized evidence system.
4. Dispatch the same workflow on the reviewed main commit with `operation=publish`, the same channel and SHA, the successful `signed_run_id`, the accepted `installer_sha256`, and an HTTPS `acceptance_url` for the reviewer. The publish job fetches the exact candidate from that run. It verifies the file inventory, update metadata and served binary before promoting `latest.yml`. The job summary contains the verified installer download URL.
5. Check a fresh download from that URL on an intended Windows PC and observe browser approval through the first order Proof.

Publication retries can reuse the same run and accepted checksum. A failed upload before feed promotion leaves the prior feed intact. Versioned files are immutable and concurrent pointer writes use the previous ETag. If a published release needs correction, publish a signed higher version compatible with the retained queue. Use the existing production operations process to contain a faulty release or restore service availability.
