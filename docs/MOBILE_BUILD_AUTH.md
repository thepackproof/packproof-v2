# Mobile release authentication

PackProof's existing Expo automation token is stored in AWS Secrets Manager at `packproof/build/expo/2026-09-08-proof-navigation` in account `784514617543`, region `us-east-1`. Earlier signed releases used CodeBuild's `SECRETS_MANAGER` environment injection. An empty GitHub `secrets.EXPO_TOKEN` therefore does not establish that Expo authentication is missing.

The Android AAB and optional signed iOS workflows use `.github/actions/expo-auth`. An existing GitHub secret is still supported. Otherwise, a release running from `main` uses GitHub OIDC to assume `PackProofGitHubMobileBuildSecret` and the pinned AWS action injects the existing token as a masked environment variable. Pull requests and other branches cannot assume this role. Its sole permissions are read/describe access to this exact secret; the role definition is recorded in `infra/iam/mobile-build-secret-role.json`.

Keep the existing EAS project and remote signing credentials. Do not create a replacement Expo token, Play keystore, or Apple signing identity to resolve this workflow wiring issue. Never print the token, put it in build artifacts, or set it as an `EXPO_PUBLIC_` variable.

Validate authentication through the release workflow or the existing authorized CodeBuild secret injection. A failure at Expo sign-in is distinct from signing-credential availability, artifact validation, or store review.

The workstation UI Android candidate uses version code 56. On October 8, 2026, the authenticated Play Console showed production version 1.0.1 (52) available at full rollout, with 52 also the latest uploaded app bundle. EAS build history previously used codes 52 through 55; build history does not establish Play publication. The shipping profile pins 56 on the remote builder as well as the local configuration. The user authorized Android production publication while explicitly holding iOS until Apple's current review completes; do not dispatch an iOS build or submission for this release.
