# Research API and generated client

`backend/rnd-openapi.json` describes the additive R&D API using OpenAPI 3.1 / JSON Schema 2020-12. The production contract remains `backend/openapi.json`. The research document includes 33 operations across capture, sidecars, analyses, enrollment, annotations, platform challenges, exports, privacy grants and administration. Evidence records reference the actual JSON Schemas in `packages/evidence-contracts/schemas`.

Analysis inputs discriminate on feature and expose bounded parameter shapes. Client input cannot choose a model file, executable, threshold, challenge schedule, tenant, qualified state, or physical verdict. Committed source authorization, image dimensions, cryptographic assertions, consent, queue limits and feature flags remain server checks. An accepted asynchronous request can later fail or abstain. The response keeps operational state separate from finding state.

The package contains a dependency-free generated transport and TypeScript declaration file. `scripts/generate-rnd-client.mjs` supports the schema vocabulary used by this document, resolves local shared schema references, and refuses unknown type structures or external network references. It is an API-specific generator, not a general OpenAPI implementation. Its digest covers the API document, referenced shared schemas and generator. The client does not perform runtime body/schema validation or signature verification.

```sh
node scripts/generate-rnd-client.mjs
node scripts/generate-rnd-client.mjs --check
node packages/evidence-contracts/test/generated-client.test.mjs
node backend/node_modules/typescript/bin/tsc --noEmit --strict --module nodenext --target ES2022 --lib es2022,dom packages/evidence-contracts/test/generated-client-types.mts
python -m venv /tmp/packproof-openapi-venv
/tmp/packproof-openapi-venv/bin/pip install -r scripts/requirements-rnd-contracts.txt
/tmp/packproof-openapi-venv/bin/python scripts/check-rnd-openapi.py
```

The same checks run in the existing isolated R&D workflow. The transport tests compare every documented path/method with the actual mounted routers and compare accepted request keys with server `onlyKeys` allowlists. JSON Schema checks use the maintained, pinned `jsonschema` validator and resolve all shared contracts offline. The measured validation record is `docs/rnd/validation/api-contracts.json`.

Existing authenticated applications should use the pure builder, preserving their current token/account boundary:

```ts
import {buildRndRequest} from '../../packages/evidence-contracts/generated-client.mjs';

const request = buildRndRequest('requestAnalysis', {
  path: {id: proofId},
  idempotencyKey: existingRequestKey,
  body: {feature: 'proofpilot', evidenceIds, parameters: {samplingHz: 2}},
});
// Pass request.path, request.method, structured request.body and request.headers
// to the application's existing authenticated, account-fenced request helper.
```

`createRndClient({baseUrl, fetch, headers})` is available for consumers with their own transport and authentication policy. It also exposes named methods and generic `request(operationId, input)`. Binary artifact/ZIP operations return `ArrayBuffer`; JSON operations return the generated result type. `RndInput<K>` and `RndOutput<K>` expose endpoint types. Failed responses throw `RndApiError` with status and server error code. The adapter does not store tokens, refresh sessions, retry operations, follow redirects or log request material.

Every mutating operation requiring `Idempotency-Key` includes it in its input type. The builder rejects unknown operations, unexpected path/query fields, unsafe path values, missing keys and unexpected bodies. Retrying an existing operation must retain its original idempotency key and body. A derivative grant returns its bearer token only once; no generated client cache retains it. Redeem submits the token in a JSON body and receives only the reviewed derivative archive.

Mode names are `condition2d` / `sparse3d` for ProofTwin, `enroll` / `compare` for ProofPrint, and `redact` / `zk-enroll` / `zk-prove` for ProofShield. Omitting mode selects the bounded default. Sparse reconstruction still requires an object mask for every selected view; the schema alone cannot establish a physical object association. No API or client validation grants release authorization or physical qualification.
