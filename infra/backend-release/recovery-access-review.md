# Recovery access review and continuation

**Proposal only — no permission has been granted.** Review the accompanying [identity-policy proposal](recovery-access-proposal.json) for the existing caller role `PackProofGitHubDeploy`. It contains exactly two new Allows:

| Action | Exact resource |
|---|---|
| `codebuild:ListBuildsForProject` | `arn:aws:codebuild:us-east-1:784514617543:project/packproof-v2-staging-api` |
| `iam:SimulatePrincipalPolicy` | `arn:aws:iam::784514617543:role/packproof-v2-staging-execution` |

There are no wildcard actions/resources, secret-value reads, mutation rights, or grants for a dedicated owner role. These files contain no apply commands or automatic permission-change mechanism.

## Observed blockers

The following operations returned access denied on **November 24, 2026 (UTC)**:

| Operation | Time | Actual workflow job |
|---|---|---|
| `ListBuildsForProject` | 00:10:57 | [run45294832671 / job138112555193](https://github.com/thepackproof/packproof-v2/actions/runs/45294832671/job/138112555193) |
| `SimulatePrincipalPolicy` | 00:15:41 | [run45295525468 / job138114987424](https://github.com/thepackproof/packproof-v2/actions/runs/45295525468/job/138114987424) |
| Dedicated owner-role `GetRole` lookup | 00:18:29 | [run45295974339 / job138116371151](https://github.com/thepackproof/packproof-v2/actions/runs/45295974339/job/138116371151) |

The denials do not establish whether an identity policy, session restriction, permissions boundary, or organization SCP is responsible. An added Allow cannot override an applicable explicit Deny. An AWS administrator must review the effective authorization and decide whether these narrowly scoped additions are appropriate. The dedicated-role lookup returned access denied, **not** `NoSuchEntity`; it establishes neither existence nor absence of that role.

[PR196](https://github.com/thepackproof/packproof-v2/pull/196) corrected the `BatchGetBuilds` session-policy resource to the project ARN. Actual base-role access to that operation remains unverified because listing failed first. This proposal adds no `BatchGetBuilds` permission.

## Preserve the release state

The fixed runtime source is `67e4f1df823b69052fb254e8fa240a3f03ef91b6`, qualified by [main CI45286966630](https://github.com/thepackproof/packproof-v2/actions/runs/45286966630). The first actual CodeBuild execution started at approximately **23:35UTC on November 23**; its ID and status remain unrecovered. [Original build job](https://github.com/thepackproof/packproof-v2/actions/runs/45289918824/job/138095809046).

After effective authorization is reviewed, continue through the existing supported inspection and bounded exact-source build-recovery workflow. Recover and review the prior build before considering another start. A failed, conflicting, ambiguous, or incompletely observed build must remain a stop condition.

No API, worker, schema, portal, or facility-activation cutover has occurred. This proposal is not an implemented permission fallback. Its approval or merge is not evidence of a live fix, and must not be presented as delivery of a replacement installer that resolves the hosted setup failure.

## AWS authorization references

- [CodeBuild permissions reference](https://docs.aws.amazon.com/codebuild/latest/userguide/auth-and-access-control-permissions-reference.html)
- [IAM service authorization reference — SimulatePrincipalPolicy supports the role resource](https://docs.aws.amazon.com/service-authorization/latest/reference/list_iam.html)
- [Permissions required to use the IAM policy simulator](https://docs.aws.amazon.com/IAM/latest/UserGuide/permissions-required_policy-simulator.html)
