export const LEGAL_LAST_UPDATED = "September 1, 2026";

/** Visible until a legal entity and contact addresses are confirmed. */
export const LEGAL_ENTITY_PLACEHOLDER = "[LEGAL ENTITY NAME — developer review]";
export const PRIVACY_CONTACT_PLACEHOLDER = "[PRIVACY CONTACT EMAIL — developer review]";
export const LEGAL_CONTACT_PLACEHOLDER = "[LEGAL / SUPPORT CONTACT EMAIL — developer review]";
export const MAILING_ADDRESS_PLACEHOLDER = "[MAILING ADDRESS — developer review]";
export const GOVERNING_LAW_PLACEHOLDER = "[GOVERNING LAW AND VENUE — developer review]";

const PLACEHOLDER_PATTERN = /\[[^[\]]+— developer review\]/g;

export type LegalKind = "privacy" | "terms";

export interface LegalSection {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  closingParagraphs?: string[];
}

export interface LegalDocument {
  kind: LegalKind;
  path: "/new/privacy" | "/new/terms";
  title: string;
  description: string;
  lastUpdated: string;
  sections: LegalSection[];
}

export function highlightDeveloperPlaceholders(text: string): string {
  return text.replace(
    PLACEHOLDER_PATTERN,
    (match) => `<mark class="legal-placeholder">${escapeHtml(match)}</mark>`,
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const privacyPolicy: LegalDocument = {
  kind: "privacy",
  path: "/new/privacy",
  title: "Privacy Policy",
  description:
    "How PackProof collects, uses, stores, and retains information for accounts, marketplace connections, and evidentiary records.",
  lastUpdated: LEGAL_LAST_UPDATED,
  sections: [
    {
      id: "who-we-are",
      title: "1. Who we are",
      paragraphs: [
        `This Privacy Policy describes how ${LEGAL_ENTITY_PLACEHOLDER} (“PackProof,” “we,” “us”) handles information in connection with the PackProof service, including the PackProof API, the first-party web application, and the mobile client.`,
        "PackProof is evidence infrastructure. It records, timestamps, hashes, stores, and retrieves transaction-bound records (“Proofs”). PackProof does not adjudicate disputes, determine liability, or independently verify that marketplace-supplied transaction claims, packing statements, or carrier events are true in the real world.",
        `Questions about this policy: ${PRIVACY_CONTACT_PLACEHOLDER}. Mailing address: ${MAILING_ADDRESS_PLACEHOLDER}.`,
      ],
    },
    {
      id: "scope",
      title: "2. Scope",
      paragraphs: [
        "This policy covers personal information and related operational data processed when you create a PackProof account, authenticate, connect an external identity or marketplace, import transaction metadata, capture or upload evidence, attest, finalize a Proof, or otherwise use the service.",
        "It also covers information we receive from third-party providers you authorize (for example, eBay or Shopify when you connect a seller or shop account, or Google and Meta/Facebook when you link those identities) and from infrastructure providers that host PackProof.",
        "This policy does not govern the privacy practices of marketplaces, carriers, identity providers, or other third parties. Those services have their own policies.",
      ],
    },
    {
      id: "account",
      title: "3. PackProof account and profile information",
      paragraphs: [
        "When you use PackProof we create a PackProof user identifier. Depending on how you set up your account, we may store:",
      ],
      bullets: [
        "PackProof user id",
        "username and display name",
        "account status (for example, active or disabled) and account timestamps",
        "profile fields you submit so other PackProof users can find and invite you",
      ],
    },
    {
      id: "authentication",
      title: "4. Authentication information",
      paragraphs: [
        "PackProof maps a verified sign-in identity to your PackProof user. We store the identity provider name and the provider’s subject identifier. We do not treat email address as a key that merges separate accounts.",
        "In production deployments, account sign-in is handled by Amazon Cognito. PackProof receives tokens needed to authenticate API requests. The web application keeps the current tab’s session in the browser’s sessionStorage. The password you type into PackProof’s hosted sign-in form is sent to Cognito, not stored by the PackProof API as your account password.",
        "Development environments may use a separate development sign-in adapter. That adapter is not the production authentication system.",
      ],
    },
    {
      id: "external-identities",
      title: "5. Connected external identities",
      paragraphs: [
        "If you link an external identity to your PackProof user, we may store the provider, provider subject, optional handle or display name, optional avatar URL, linkage timestamps, and flags that describe whether that identity can authenticate or appear on a profile.",
        "PackProof does not merge two PackProof users because they share an email address or a similar name. Connecting an identity associates that provider subject with the PackProof user who completed the connection.",
        "Supported identity-provider records in the current architecture include Amazon Cognito and development identities. Additional social providers may be added later; if you connect one, the same category of linkage data applies.",
      ],
    },
    {
      id: "marketplaces",
      title: "6. Marketplace integrations, including eBay",
      paragraphs: [
        "If you connect a marketplace such as eBay, PackProof stores a connection record for your PackProof user. That record may include the provider, adapter, environment (sandbox or production), connection status, and a provider account reference such as an eBay user id or username.",
        "Connecting eBay uses OAuth. PackProof requests access needed to complete seller authorization, read seller fulfillment orders, and read limited commerce identity information used to establish the connection. PackProof treats eBay as a connected marketplace, not as a PackProof sign-in identity.",
        "If you connect a Shopify shop, PackProof stores the shop identity and requests official Admin API access to read orders and fulfillments used to create PackProofs. One PackProof user may connect more than one shop.",
        "If you connect Google or Meta/Facebook from Account, PackProof stores only the official identity the provider returns (such as a subject, name, or public profile). Those connections are not Amazon Cognito sign-in and do not replace PackProof authentication. PackProof does not import Facebook Marketplace listings or transactions because Facebook does not offer an official public Marketplace API for that purpose.",
        "You can disconnect a marketplace connection from PackProof. Disconnecting deletes stored OAuth credentials for that connection and disables the connection. It does not delete Proofs or evidence already created from imported orders.",
      ],
    },
    {
      id: "imported-orders",
      title: "7. Transaction and order metadata imported from connected marketplaces",
      paragraphs: [
        "When you import an order, PackProof stores transaction metadata supplied by the provider or entered by you. That may include order identifiers, line-item identifiers, listing or item titles, quantities, prices and currency when provided, buyer identifiers or display names when provided, marketplace identifiers, and timestamps.",
        "PackProof does not invent missing marketplace fields. If a provider omits a buyer name, price, tracking number, or similar value, PackProof leaves that field empty rather than filling it in.",
        "Imported marketplace data is classified as external data. PackProof does not independently verify that an imported order, item description, price, or counterparty identity is accurate.",
      ],
    },
    {
      id: "shipping",
      title: "8. Shipping and carrier information",
      paragraphs: [
        "You or a connected integration may supply carrier names, tracking numbers, shipping addresses or service descriptions, and shipment event observations. Staging environments may also receive tracking observations from a trusted carrier adapter (including EasyPost Tracker where that adapter is configured).",
        "Shipment observations are recorded as supplied. A PackProof shipment-integrity digest reflects the integrity of PackProof’s stored record. It is not a determination that a carrier’s real-world statement is true.",
      ],
    },
    {
      id: "evidence",
      title: "9. Evidence you upload or capture",
      paragraphs: [
        "Participants may capture or upload files associated with a Proof, such as packing photos or video. PackProof stores the object bytes in an object store, together with content type, size, submitter, evidence type, and a SHA-256 digest computed for the stored object.",
        "Evidence is append-only after commit. PackProof does not edit committed evidence in place or replace a file while keeping the same evidence id. Clients may show capture or upload progress; that interface state is not Proof state.",
      ],
    },
    {
      id: "attestations",
      title: "10. Attestations",
      paragraphs: [
        "Participants may record bounded statements on a Proof (for example, that they packed the described item). PackProof stores who attested, the statement, related evidence identifiers, and timestamps.",
        "An attestation is a participant claim that PackProof recorded. PackProof does not independently verify that the statement is true.",
      ],
    },
    {
      id: "integrity-metadata",
      title: "11. Timestamps, hashes, provenance, audit events, and technical metadata",
      paragraphs: [
        "For each Proof, PackProof stores technical and integrity metadata needed to retrieve and evaluate the record, including:",
      ],
      bullets: [
        "Proof, transaction, participant, invitation, evidence, and event identifiers",
        "lifecycle status and server-side transition timestamps",
        "SHA-256 digests for committed evidence and, after finalization, a canonical manifest digest",
        "provenance describing whether a value came from PackProof infrastructure, a participant attestation, or an external source such as a marketplace",
        "append-only audit events for committed actions",
        "invitation and participation records used to authorize access",
      ],
    },
    {
      id: "oauth-credentials",
      title: "12. OAuth authorization and refresh credentials",
      paragraphs: [
        "When you authorize a marketplace, PackProof receives authorization and refresh credentials from that provider. Those credentials are stored only on the server. They are not returned to the web or mobile client, embedded in client configuration, or written onto Proof records.",
        "Connection records store a credential reference, not the token values themselves.",
      ],
    },
    {
      id: "credential-storage",
      title: "13. Secure server-side credential storage",
      paragraphs: [
        "In AWS deployments, PackProof stores marketplace OAuth credentials in AWS Secrets Manager under application-managed secret names. Memory may be used as a cache. Local development may keep credentials in process memory or environment configuration instead of Secrets Manager.",
        "Application credentials for PackProof itself (for example, database passwords and provider client secrets) are injected as server environment or secret references. They are not shipped in the public web bundle.",
      ],
    },
    {
      id: "aws",
      title: "14. AWS infrastructure",
      paragraphs: [
        "When PackProof is operated on AWS, information is processed using Amazon Web Services in the configured region. Typical components include:",
      ],
      bullets: [
        "Amazon Cognito for account authentication",
        "PostgreSQL on Amazon RDS or Aurora PostgreSQL for canonical domain state",
        "Amazon S3 for evidence object bytes",
        "Amazon ECS / Fargate for the PackProof API",
        "Amazon S3 and Amazon CloudFront for the web application",
        "AWS Secrets Manager for integration credentials",
        "Amazon CloudWatch for service and security logs",
      ],
    },
    {
      id: "minimization",
      title: "15. Data minimization",
      paragraphs: [
        "PackProof is designed to store what the product needs to authenticate you, authorize access, import the orders you select, record evidence and attestations, and preserve a retrievable integrity record.",
        "Marketplace import stores provider identifiers and fields the provider actually returned. PackProof does not synthesize buyer, price, or tracking values. OAuth tokens are not copied into Proof manifests or client storage. Proof tables do not store Firebase, Cognito, Google, or Apple identifiers as Proof identity; those subjects map through separate identity records.",
      ],
    },
    {
      id: "logging",
      title: "16. Service and security logging",
      paragraphs: [
        "PackProof and its infrastructure providers may log operational data such as request paths, timestamps, identifiers, error codes, and diagnostic messages in order to operate, secure, and troubleshoot the service.",
        "PackProof is designed not to return secret values in API error messages or to store OAuth tokens on Proof records. Logs may still contain user ids, Proof ids, and similar identifiers.",
      ],
    },
    {
      id: "cookies",
      title: "17. Cookies, local storage, and session information",
      paragraphs: [
        "The PackProof web application stores the signed-in session for the current browser tab in sessionStorage. Clearing the tab, signing out, or receiving an unauthorized API response clears that session. The web client does not currently use localStorage for the PackProof session and does not currently set first-party advertising cookies.",
        "If you use PackProof on a device that supports other browser storage, the browser may still keep ordinary technical data such as cache entries for static files.",
        "Third parties you interact with—including Amazon Cognito and eBay—may set their own cookies or storage when you use their sign-in or authorization pages. PackProof does not control those cookies.",
      ],
    },
    {
      id: "use",
      title: "18. How PackProof uses collected data",
      paragraphs: [
        "We use the information described in this policy to:",
      ],
      bullets: [
        "create and authenticate PackProof accounts",
        "authorize access to Proofs you participate in",
        "connect and disconnect marketplace integrations you request",
        "import and display order metadata you select",
        "accept evidence uploads, compute and store digests, record attestations, and finalize Proofs",
        "maintain append-only audit history and retrieve manifests",
        "operate, secure, debug, and improve the service",
        "respond to your requests and to provider account-deletion notifications",
        "comply with law and protect PackProof, our users, and the integrity of stored records",
      ],
    },
    {
      id: "source-labels",
      title: "19. How marketplace and provider information is distinguished from PackProof facts",
      paragraphs: [
        "Every value on a Proof is treated as one of three kinds:",
      ],
      bullets: [
        "PackProof fact — something PackProof can establish from its own infrastructure, such as when a Proof was recorded, who joined as a participant, that an object was received, or that a SHA-256 digest was computed and stored",
        "User attestation — a participant statement PackProof recorded but did not independently verify",
        "External data — metadata supplied by a participant or integration, including marketplace order fields and carrier observations",
      ],
      closingParagraphs: [
        "PackProof does not promote an attestation or external field into a PackProof fact. PackProof does not independently verify marketplace-supplied transaction claims, item authenticity, or the truth of a packing or shipping statement.",
      ],
    },
    {
      id: "no-sale",
      title: "20. PackProof does not sell personal data",
      paragraphs: [
        "PackProof does not sell personal data. PackProof does not share personal data for cross-context behavioral advertising.",
      ],
    },
    {
      id: "disconnect",
      title: "21. Disconnecting marketplace integrations",
      paragraphs: [
        "You may disconnect a marketplace connection such as eBay from PackProof. When you do, PackProof deletes stored OAuth credentials for that connection and disables the connection so PackProof can no longer call that provider on your behalf. The same disconnect control applies to Shopify shops and to Google or Meta/Facebook identity links.",
        "Imported transactions, Proofs, evidence, attestations, manifests, and audit events that already exist are not deleted by disconnecting a marketplace.",
      ],
    },
    {
      id: "account-deletion",
      title: "22. Account deletion requests",
      paragraphs: [
        `You may request deletion of your PackProof account by contacting ${PRIVACY_CONTACT_PLACEHOLDER}. PackProof does not currently offer an in-product self-serve account deletion control.`,
        "We will review account deletion requests. Access credentials and connection tokens associated with your account can be removed or disabled. PackProof may still retain finalized evidentiary records as described below.",
      ],
    },
    {
      id: "provider-deletion",
      title: "23. Provider account deletion notifications",
      paragraphs: [
        "Some providers, including eBay, may notify PackProof that a user closed their provider account. When PackProof processes such a notification, it deletes stored OAuth credentials for matching connections, disables those connections, and anonymizes the stored provider display reference.",
        "Provider account closure does not, by itself, delete PackProof Proofs, evidence bytes, manifests, or audit events. Provider account data and PackProof evidentiary records are separate.",
      ],
    },
    {
      id: "retention",
      title: "24. Retention of finalized evidentiary records",
      paragraphs: [
        "A Proof is a persistent, server-side record. Navigation, logout, capture UI state, and local device storage do not delete or invalidate a Proof.",
        "After a Proof is finalized, PackProof rejects mutation of Proof status, committed evidence, attestations, core transaction facts, and the canonical manifest. PackProof may retain finalized evidentiary records, committed evidence objects, hashes, timestamps, provenance, and audit events where it has a legitimate operational, security, legal, or integrity reason to preserve them—including so that other participants can still retrieve the same record, and so that PackProof can maintain an append-only history.",
        "Shipment observations may be appended after finalization; they do not rewrite the frozen core manifest.",
      ],
    },
    {
      id: "security",
      title: "25. Security practices",
      paragraphs: [
        "PackProof uses HTTPS for the hosted API and web application. Durable Proof changes authenticate, authorize, load the Proof, validate the transition, and persist in a database transaction with constraints and audit events.",
        "Evidence bytes are stored in an object store. Canonical domain state is stored in PostgreSQL. Marketplace tokens are stored server-side as described above. The public web bundle does not contain API secrets or database credentials.",
        `These practices reduce risk; they are not a guarantee that unauthorized access, loss, or alteration cannot occur. You should notify us promptly at ${PRIVACY_CONTACT_PLACEHOLDER} if you believe your account or a connection has been compromised.`,
      ],
    },
    {
      id: "processors",
      title: "26. Third-party service providers",
      paragraphs: [
        "PackProof uses service providers to operate the product. Depending on configuration, these include:",
      ],
      bullets: [
        "Amazon Web Services, including Cognito, compute, database, object storage, content delivery, secrets, and logging",
        "eBay, when you choose to connect an eBay account",
        "Shopify, when you choose to connect a shop",
        "Google, when you choose to link a Google identity (this is not Cognito sign-in)",
        "Meta/Facebook, when you choose to link a Facebook identity (this is not Cognito sign-in and is not Facebook Marketplace import)",
        "EasyPost, when a staging or test tracking adapter is configured for shipment observations",
      ],
      closingParagraphs: [
        "Providers process information according to their terms and PackProof’s instructions where applicable. PackProof does not control a marketplace’s or carrier’s own data practices.",
      ],
    },
    {
      id: "rights",
      title: "27. Your rights and how to contact us",
      paragraphs: [
        "Depending on where you live, you may have rights to request access to, correction of, or deletion of personal information, or to object to or restrict certain processing. PackProof will consider requests as required by applicable law, subject to the retention of evidentiary records described above and to verification of the requester’s identity.",
        `To make a request, contact ${PRIVACY_CONTACT_PLACEHOLDER}. If we deny a request in whole or in part, we will explain the reason we are able to provide, including where retention is required to preserve a finalized Proof or to protect the rights of another participant.`,
      ],
    },
    {
      id: "changes",
      title: "28. Changes to this policy",
      paragraphs: [
        "We may update this Privacy Policy from time to time. The “Last updated” date at the top of this page will change when we do. The current version is published at the /new/privacy path of the PackProof web application.",
        "If we make material changes, we may also provide additional notice in the product when practical. Continued use of PackProof after an update means the updated policy applies to that ongoing use.",
      ],
    },
  ],
};

export const termsOfService: LegalDocument = {
  kind: "terms",
  path: "/new/terms",
  title: "Terms of Service",
  description: "Initial terms for using PackProof as neutral evidence infrastructure.",
  lastUpdated: LEGAL_LAST_UPDATED,
  sections: [
    {
      id: "agreement",
      title: "1. Agreement",
      paragraphs: [
        `These Terms of Service (“Terms”) are an agreement between you and ${LEGAL_ENTITY_PLACEHOLDER} (“PackProof,” “we,” “us”) for use of the PackProof API, web application, and mobile client.`,
        "By creating an account, signing in, connecting a marketplace, uploading evidence, or otherwise using PackProof, you agree to these Terms and to the Privacy Policy published at /new/privacy. If you do not agree, do not use the service.",
        `Contact: ${LEGAL_CONTACT_PLACEHOLDER}. Mailing address: ${MAILING_ADDRESS_PLACEHOLDER}.`,
      ],
    },
    {
      id: "the-service",
      title: "2. PackProof is neutral evidence infrastructure",
      paragraphs: [
        "PackProof is neutral evidence infrastructure. It records, timestamps, hashes, stores, and retrieves transaction-bound evidence records (“Proofs”). Clients issue commands. PackProof’s servers decide whether a Proof exists, what its status is, and whether a transition is valid.",
        "PackProof is early-stage software. Features, interfaces, and availability may change. Unless we agree otherwise in a signed writing, PackProof is provided as a hosted service, not as a custom professional-services engagement.",
      ],
    },
    {
      id: "not-adjudicator",
      title: "3. PackProof is not an adjudicator",
      paragraphs: [
        "PackProof is not a court, arbitrator, marketplace, payment processor, carrier, insurer, or claims desk. PackProof does not determine fraud, liability, ownership, authenticity, or the outcome of a dispute.",
        "Nothing in a PackProof record constitutes legal advice, a warranty about goods, or a finding that a party is verified, guilty, innocent, or correct.",
      ],
    },
    {
      id: "statements",
      title: "4. No guarantee that participant statements are true",
      paragraphs: [
        "Attestations, packing statements, item descriptions, and similar content are recorded as submitted by participants. PackProof does not guarantee that those statements are true, complete, or authorized.",
        "A SHA-256 digest or finalized manifest shows that PackProof stored particular bytes and metadata. It does not prove that the real-world item, pack-out, or shipment matched the statement.",
      ],
    },
    {
      id: "external-data",
      title: "5. External and provider-supplied data",
      paragraphs: [
        "Order details, buyer information, tracking numbers, and similar fields may be supplied by you or by a third-party provider such as eBay. PackProof labels that information as external data. PackProof does not independently verify marketplace-supplied transaction claims.",
        "If a provider’s data is wrong, incomplete, delayed, or unavailable, PackProof may store or display it as received, or omit fields the provider did not supply.",
      ],
    },
    {
      id: "uploads",
      title: "6. Your responsibility for lawful uploads and use",
      paragraphs: [
        "You are responsible for the accounts you control, the integrations you authorize, and the content you submit. You represent that you have the right to upload evidence and import order data, and that your use complies with applicable law and with the terms of marketplaces and other providers you connect.",
        "Do not upload content you are not allowed to share, including others’ personal information without a lawful basis, or material that infringes intellectual property.",
      ],
    },
    {
      id: "misuse",
      title: "7. Prohibited misuse",
      paragraphs: [
        "You may not:",
      ],
      bullets: [
        "attempt to access Proofs, accounts, or credentials you are not authorized to use",
        "interfere with hashing, finalization, audit history, or other integrity controls",
        "use PackProof to commit fraud, launder funds, traffic in illegal goods, or harass others",
        "probe, scan, or burden the service except as expressly permitted in writing",
        "misrepresent PackProof records as independent verification of an item, seller, or claim outcome",
        "resell or scrape the service in a way that violates these Terms",
      ],
    },
    {
      id: "integrity",
      title: "8. Evidence integrity and finalization",
      paragraphs: [
        "Committed evidence is append-only. After a Proof is finalized, PackProof rejects mutation of Proof status, committed evidence, attestations, core transaction facts, and the canonical manifest.",
        "You understand that finalization is intended to freeze the core record, not to guarantee that participants told the truth. Later shipment observations, if recorded, do not rewrite the frozen core digest.",
        "PackProof may retain finalized records for operational, security, legal, or integrity reasons, including so other participants can retrieve the same Proof.",
      ],
    },
    {
      id: "accounts",
      title: "9. Accounts and integrations",
      paragraphs: [
        "You must keep your sign-in credentials confidential and tell us if you believe they were compromised. You are responsible for activity on your PackProof account and on marketplace connections you authorize.",
        "You may disconnect a marketplace integration. Disconnecting removes stored provider credentials and disables the connection. It does not delete existing Proofs or evidence.",
        "If a provider notifies PackProof that a provider account was closed, PackProof may delete stored OAuth credentials, disable the connection, and anonymize the provider display reference without deleting evidentiary records.",
      ],
    },
    {
      id: "availability",
      title: "10. Availability",
      paragraphs: [
        "PackProof does not warrant uninterrupted, error-free, or timely availability. Maintenance, defects, third-party outages (including AWS, Cognito, or eBay), and configuration limits may delay or prevent access.",
        "Local, staging, and production environments may differ. Sandbox marketplace connections are not production marketplace connections.",
      ],
    },
    {
      id: "ip",
      title: "11. Intellectual property",
      paragraphs: [
        "PackProof and its licensors retain all rights in the service, software, trademarks, and documentation. These Terms do not grant you a right to copy the product, reverse engineer it except where prohibited restrictions are unenforceable, or use PackProof branding without permission.",
        "You retain rights in content you upload, and you grant PackProof a non-exclusive license to store, hash, display, and transmit that content as needed to operate the service and preserve Proofs.",
      ],
    },
    {
      id: "disclaimer",
      title: "12. Disclaimers",
      paragraphs: [
        "PACKPROOF IS PROVIDED “AS IS” AND “AS AVAILABLE.” TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.",
        "We do not warrant that records will be accepted by any marketplace, carrier, insurer, court, or counterparty, or that the service will meet your legal or evidentiary requirements.",
      ],
    },
    {
      id: "liability",
      title: "13. Limitation of liability",
      paragraphs: [
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, PACKPROOF AND ITS SUPPLIERS WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DATA, BUSINESS INTERRUPTION, OR COST OF SUBSTITUTE SERVICES, EVEN IF ADVISED OF THE POSSIBILITY.",
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, PACKPROOF’S TOTAL LIABILITY FOR ALL CLAIMS ARISING OUT OF THESE TERMS OR THE SERVICE IS LIMITED TO THE GREATER OF (A) THE AMOUNTS YOU PAID TO PACKPROOF FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE CLAIM OR (B) ONE HUNDRED U.S. DOLLARS (US$100). IF YOU HAVE NOT PAID PACKPROOF, THE US$100 CAP APPLIES.",
        "Some jurisdictions do not allow certain limitations. In those jurisdictions, the limitation applies to the fullest extent permitted.",
      ],
    },
    {
      id: "law",
      title: "14. Governing law",
      paragraphs: [
        `These Terms are governed by ${GOVERNING_LAW_PLACEHOLDER}, without regard to conflict-of-law rules. Courts located in that venue have exclusive jurisdiction, except that PackProof may seek injunctive relief in any forum to protect the service or evidentiary integrity.`,
      ],
    },
    {
      id: "changes-terms",
      title: "15. Changes",
      paragraphs: [
        "We may update these Terms from time to time. The “Last updated” date will change when we do. The current version is published at the /new/terms path of the PackProof web application. Continued use after an update constitutes acceptance of the updated Terms.",
      ],
    },
    {
      id: "contact",
      title: "16. Contact",
      paragraphs: [
        `For these Terms: ${LEGAL_CONTACT_PLACEHOLDER}. For privacy requests: ${PRIVACY_CONTACT_PLACEHOLDER}. Mailing address: ${MAILING_ADDRESS_PLACEHOLDER}.`,
      ],
    },
  ],
};

export const legalDocuments: LegalDocument[] = [privacyPolicy, termsOfService];

export function legalDocumentByKind(kind: LegalKind): LegalDocument {
  return kind === "privacy" ? privacyPolicy : termsOfService;
}
