# Windows Connect blocker register

Date: 2026-11-06. Continue independent implementation when a downstream prerequisite is missing. Do not repeatedly retry an unchanged external failure.

| ID | Evidence / last verified state | Affected gate | Required resolution |
| --- | --- | --- | --- |
| B01 | The base host had no SDK. A scratch .NET 10.0.403 SDK now compiles the service and bridge. This host is Linux, so actual Windows service/ACL/logoff/reboot behavior requires Windows evidence. | G0–G2 | Run the exact-source Windows candidate workflow and native acceptance on Windows 11 x64. |
| B02 | `git push --dry-run origin HEAD` failed: could not read Username for https://github.com. Connected GitHub account does have repository write permission. | Source publication / native CI | Resolved for source publication: connected GitHub API created PR 147 and exact tree 82f8c7ea3acd00fb5fefbd0c139557ed7bd0ee3a. No personal token is needed. |
| B03 | No named approved nonproduction organization, eligible administrator session and current import capability were supplied. Source code supports the routes; that does not establish deployment. | G1 | Select an authorized sandbox organization and apply reviewed migration/role changes through the existing release channel; perform the actual Windows export-to-record test. |
| B04 | No Connect signed candidate, signing receipt or publisher validation has been produced. Existing Desktop signing channels are patterns, not a Connect acceptance result. | G2 / G4 | Build with the existing protected signing identity, verify every shipped executable and test the actual signed candidate. |
| B05 | No named exporter/version, customer-authorized original, source owner, Windows permissions or observed first-time users were supplied. | G3 | Validate the immutable local CSV producer contract, reconcile an authorized dataset and observe at least five representative first-time users. |
| B06 | No accepted source/cohort or exact signed package exists yet. | G4 | Complete G1–G3 and the fresh-download production canary before public distribution. |

The user authorized implementation and release within this plan. Release remains dependent on the plan's actual acceptance gates, customer data consent and configured release identity. Passing an internal build does not establish those facts or permit weakening signing, authorization or retention controls.
