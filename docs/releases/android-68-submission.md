# Android 68 production submission

The release task explicitly authorizes production publication of the capture, navigation, photo progression and next-action fixes. This record selects the finished artifact; Play review and store availability remain separate outcomes.

| Identity | Value |
| --- | --- |
| Application | `com.packproof.mobile` |
| Version | `1.0.1` / `68` |
| Source | `d94305a6a3a303b0d171f37e4d12e954e06da624` |
| EAS build | `c022e140-daab-43fa-bebd-02d81ab01148` |
| Signed build workflow | [38844730624](https://github.com/thepackproof/packproof-v2/actions/runs/38844730624) |
| GitHub artifact | `12023350450`, `packproof-1.0.1-68-aab` |
| AAB bytes | `46246504` |
| AAB SHA-256 | `058ba541fdb0c40b9c7e835b5ab66d15ffeead3e3b61a5b1b62d0971047cf2f7` |
| Archive ZIP SHA-256 | `ff931b502440e57f7f5237a13aa21792af18ac5a9fb22e09a47cd27bf030672f` |
| Play destination | Production, completed release, changes sent for review |

The complete application [CI run 38843272896](https://github.com/thepackproof/packproof-v2/actions/runs/38843272896) passed on source `5d1c91f41d371150418bf3cf951a3ca5c286a5e6`. Its backend, mobile, web, desktop, packages, infrastructure, research configuration and Android build-workflow inputs are byte-identical to the signed build source. The intervening merge adds the independently tested submission verifier, with no application changes.

[Android production receipt integration 38844730602](https://github.com/thepackproof/packproof-v2/actions/runs/38844730602) passed on the exact signed source. The downloaded bundle matches both the workflow receipt and the checksum above. Its embedded package, version, source SHA, project, API endpoint, production UX and capture-receipt flags were inspected. Native ABI alignment, R8 mappings and the preserved Expo record annotation passed. JAR signature verification and the existing upload-certificate fingerprint were checked against the actual bundle.

`config/releases/android-68.json` is the explicit submission request. The submission workflow rechecks this exact artifact, confirms unchanged application inputs and applies the existing distribution policy before using the existing Expo credential. It submits by build ID to the existing app-associated Google service account. Its result and verification receipts are retained in the **Submit verified Android 68 to Google Play** workflow.

Physical-device capture, upgrade, 200% font scaling and usability acceptance were not performed in this environment. Automated tests and artifact inspection do not constitute physical-device evidence. Desktop production publication remains separate.

## Submission outcome

[Production submission attempt 38845963306](https://github.com/thepackproof/packproof-v2/actions/runs/38845963306) passed source, distribution-policy, bundle, checksum, signature and native verification, then stopped before uploading because no Google Service Account key is assigned for Play submissions. The Expo organization credential inventory also contains no Google Service Account keys. No Play submission or live rollout is established.

The signed build above remains ready. It can be retried after the existing publishing account is configured for EAS Submit, or uploaded through an authenticated Google Play Console session. A new application build is not required to resolve this account-access blocker.
