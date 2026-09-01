import { describe, expect, it } from "vitest";
import { privacyPolicy, termsOfService } from "../legal/documents";
import { renderLegalHtml } from "../legal/render-html";

function allText(document: {
  sections: Array<{ title: string; paragraphs: string[]; bullets?: string[]; closingParagraphs?: string[] }>;
}) {
  return document.sections
    .flatMap((section) => [
      section.title,
      ...section.paragraphs,
      ...(section.bullets ?? []),
      ...(section.closingParagraphs ?? []),
    ])
    .join("\n");
}

describe("public legal documents", () => {
  it("covers the privacy topics required for the current architecture", () => {
    const text = allText(privacyPolicy).toLowerCase();
    const required = [
      "packproof user identifier",
      "amazon cognito",
      "sessionstorage",
      "external identity",
      "ebay",
      "oauth",
      "secrets manager",
      "order identifiers",
      "tracking numbers",
      "sha-256",
      "attestation",
      "audit events",
      "cloudwatch",
      "does not sell personal data",
      "disconnect",
      "account deletion",
      "provider account",
      "finalized",
      "does not independently verify marketplace-supplied transaction claims",
    ];
    for (const phrase of required) {
      expect(text, phrase).toContain(phrase);
    }
    expect(text).not.toContain("independently verifies marketplace");
  });

  it("covers the initial terms topics", () => {
    const text = allText(termsOfService).toLowerCase();
    const required = [
      "neutral evidence infrastructure",
      "not an adjudicator",
      "does not guarantee that those statements are true",
      "does not independently verify marketplace-supplied transaction claims",
      "lawful",
      "prohibited",
      "append-only",
      "disconnect",
      "uninterrupted",
      "intellectual property",
      "as is",
      "limitation of liability",
    ];
    for (const phrase of required) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("emits static HTML that a CloudFront URL checker can read without javascript", () => {
    const html = renderLegalHtml(privacyPolicy, ".page-legal { max-width: 46rem; }");
    expect(html).toContain("<h1>Privacy Policy</h1>");
    expect(html).toContain("Last updated September 1, 2026");
    expect(html).toContain("/new/terms");
    expect(html).toContain("/packproof-logo.png");
    expect(html).not.toContain("Sign in");
    expect(html).toContain("legal-placeholder");
  });
});
