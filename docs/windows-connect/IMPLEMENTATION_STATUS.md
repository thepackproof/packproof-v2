# Windows Connect implementation status

Date: 2026-11-06. This file separates source implementation, test verification, deployment and customer acceptance.

## Baseline

- Repository: `thepackproof/packproof-v2`; implementation branch: `feature/packproof-connect-windows`.
- Starting commit: `a42c10653258b63217043f8670b94ca87a233684` (`main`). RFC PR 146 remains a separate draft.
- Reused: Electron/NSIS patterns in `desktop/`; organization principals and encrypted command replay; partner CSV preview/commit/status; canonical source bindings; existing records portal.
- No existing unattended Windows service was present in this checkout. The worker is a bounded .NET 10 addition; the API stays hosted.
- Target for the first actual integration: an approved nonproduction organization. No customer or production organization has been selected or activated by this work.

## Work packages

| Package | Source | Verification | Deployment / acceptance |
| --- | --- | --- | --- |
| W01 baseline/native build | In progress | Baseline inspected; Windows package pending | Internal candidate only |
| W02 service/bridge | In progress | Pending native execution | Not installed |
| W03 enrollment/restrictions | In progress | Pending focused policy cases | Not deployed |
| W04 queue/spool | In progress | Pending interruption cases | Not installed |
| W05 CSV vertical slice | In progress | Real backend test pending | No accepted source |
| W06 guided setup | In progress | Pending UI cases | Not deployed |
| W07 health/support | In progress | Pending receipt-backed cases | Not deployed |
| W08 credential lifecycle | In progress | Pending loss/recovery cases | Not deployed |
| W09 packaging/lifecycle | In progress | Pending native signed candidate | Not published |
| W10 regression/hardening | Pending integration | Pending | Not qualified |
| W11 source/novice acceptance | External prerequisites pending | No observations collected | Not accepted |
| W12 publish/canary | Downstream gates pending | No fresh-download canary | Not published |

## Completion gates

G0–G4 are pending. Test fixtures cannot pass the real Windows/backend G1 gate or customer G3 gate. Exact outcomes and artifact hashes belong in `EVIDENCE.json`; external prerequisites belong in `BLOCKERS.md`.
