import {
  escapeHtml,
  highlightDeveloperPlaceholders,
  type LegalDocument,
  type LegalSection,
} from "./documents";

function richText(text: string): string {
  return highlightDeveloperPlaceholders(escapeHtml(text));
}

function renderSection(section: LegalSection): string {
  const paragraphs = section.paragraphs.map((item) => `<p>${richText(item)}</p>`).join("\n");
  const bullets = section.bullets?.length
    ? `<ul>${section.bullets.map((item) => `<li>${richText(item)}</li>`).join("")}</ul>`
    : "";
  const closing = section.closingParagraphs?.map((item) => `<p>${richText(item)}</p>`).join("\n") ?? "";
  return `<section id="${escapeHtml(section.id)}">
  <h2>${escapeHtml(section.title)}</h2>
  ${paragraphs}
  ${bullets}
  ${closing}
</section>`;
}

export function renderLegalHtml(document: LegalDocument, pageCss: string): string {
  const other =
    document.kind === "privacy"
      ? { href: "/new/terms", label: "Terms of Service" }
      : { href: "/new/privacy", label: "Privacy Policy" };
  const toc = document.sections
    .map((section) => `<li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(document.description)}" />
    <link rel="icon" href="/packproof-logo.png" />
    <title>${escapeHtml(document.title)} — PackProof</title>
    <style>
:root {
  --navy: #142735;
  --blue: #13a8e8;
  --green: #0dce70;
  --slate: #66737d;
  --bg: #f4f6f8;
  --border: #e2e7ea;
  --white: #ffffff;
  --text: #142735;
  --radius-lg: 16px;
  --shadow: 0 2px 8px rgba(20, 39, 53, 0.06);
  --sans: "Segoe UI", system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.5;
}
.app-shell { min-height: 100vh; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--white);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  text-decoration: none;
  color: var(--navy);
}
.brand img { width: 28px; height: 28px; border-radius: 8px; }
.topbar-nav { display: flex; flex-wrap: wrap; gap: 0.35rem 0.15rem; align-items: center; }
.topbar-nav a {
  text-decoration: none;
  color: var(--slate);
  font-size: 0.92rem;
  font-weight: 600;
  padding: 0.4rem 0.7rem;
  border-radius: 999px;
}
.topbar-nav a:hover { color: var(--navy); background: var(--bg); }
.topbar-nav a[aria-current="page"] { color: var(--navy); background: #e8f6fc; }
.page {
  width: min(1080px, calc(100% - 2rem));
  margin: 0 auto;
  padding: 2rem 0 4rem;
}
h1 { font-weight: 700; letter-spacing: -0.02em; margin: 0 0 0.5rem; color: var(--navy); font-size: clamp(1.65rem, 3vw, 2rem); line-height: 1.2; }
${pageCss}
@media (max-width: 720px) {
  .topbar, .page { padding-left: 1rem; padding-right: 1rem; }
  .page { width: 100%; }
}
    </style>
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="/">
          <img src="/packproof-logo.png" alt="" width="28" height="28" />
          PackProof
        </a>
        <nav class="topbar-nav" aria-label="Legal">
          <a href="/new/privacy"${document.kind === "privacy" ? ' aria-current="page"' : ""}>Privacy</a>
          <a href="/new/terms"${document.kind === "terms" ? ' aria-current="page"' : ""}>Terms</a>
          <a href="/">Back to PackProof</a>
        </nav>
      </header>
      <main class="page page-legal">
        <p class="legal-kicker">PackProof</p>
        <h1>${escapeHtml(document.title)}</h1>
        <p class="legal-updated">Last updated ${escapeHtml(document.lastUpdated)}</p>
        <p class="legal-lede">${escapeHtml(document.description)}</p>
        <nav aria-label="Table of contents">
          <ol class="legal-toc">${toc}</ol>
        </nav>
        <article class="legal-doc">
          ${document.sections.map(renderSection).join("\n")}
        </article>
        <footer class="legal-footer">
          <a href="${other.href}">${escapeHtml(other.label)}</a>
          <a href="/">Back to PackProof</a>
        </footer>
      </main>
    </div>
  </body>
</html>
`;
}
