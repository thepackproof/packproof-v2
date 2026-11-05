# First record from an authorized source

These server examples call the existing partner Proof create/read contract using the SDKs in this repository. They preserve the source reference, operator assignment, and idempotency key; rerunning the same input opens the same logical record. They do not attest physical evidence or activate an unsupported provider.

Have the workspace administrator provide the sandbox API URL, organization-owned service credential, integration account ID, and authorized operator membership ID. Partner credentials also require the exact merchant/delegation selectors. Use a server environment or secret manager; never paste secrets into source files.

Set these environment values before execution:

| Name | Value |
| --- | --- |
| `PACKPROOF_API_BASE_URL` | Authorized backend origin or API prefix |
| `PACKPROOF_SERVICE_TOKEN` | Scoped sandbox service credential |
| `PACKPROOF_INTEGRATION_ACCOUNT_ID` | Existing source integration account |
| `PACKPROOF_OPERATOR_MEMBERSHIP_ID` | Active assigned operator |
| `PACKPROOF_SOURCE_REFERENCE` | Stable unique source shipment reference, e.g. `SHIP-00001234` |
| `PACKPROOF_MERCHANT_ID` | Exact delegated merchant, when applicable |
| `PACKPROOF_DELEGATION_ID` | Exact active grant, when applicable |

From the repository root:

```text
node examples/partner-records/first-record.mjs
python examples/partner-records/first_record.py
```

Both examples return a small receipt containing the Proof ID, whether creation was new, and the read request ID. They intentionally print no credential, source payload, or evidence bytes. Creation requires `proofs:write`, reading requires `proofs:read`, and all organization/environment/delegation gates must be active.

See the [integration quickstart](../../docs/api-portal-v1/QUICKSTART.md) for evidence capture and reconciliation. For nontechnical users, use the signed-in spreadsheet import in `/app/records`.
