import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';
import type {OfferDefinition} from '../src/billing/usage-ledger.js';
/** Isolated test-only review fixture. Never produced by normal app code. */
export function syntheticPublication(offer:OfferDefinition,at:Date){
 const document={version:'synthetic-v1',artifactSha256:'a'.repeat(64),approvalReference:offer.approvedTermsReference,approvalRecordSha256:'b'.repeat(64),servedUrl:'https://synthetic.example/policy',verifiedAt:at.toISOString()};
 const payload={schemaVersion:'packproof.publication-policy-receipt.v1',state:'passed',offerVersion:offer.version,canonicalOfferSha256:sha256Hex(canonicalize(offer)),approvedTermsReference:offer.approvedTermsReference,releaseSha:'1'.repeat(40),entitySha256:'c'.repeat(64),supportEvidenceSha256:'d'.repeat(64),approvalRegistrySha256:'e'.repeat(64),documents:{terms:document,privacy:document,support:document},evaluatedAt:at.toISOString(),expiresAt:new Date(at.getTime()+86400000).toISOString()};
 const receiptSha256=sha256Hex(canonicalize(payload));return{receipt:{...payload,receiptSha256},trustedReceiptSha256:receiptSha256,expectedReleaseSha:payload.releaseSha};
}
