import { useEffect, type MouseEvent } from "react";
import {
  escapeHtml,
  highlightDeveloperPlaceholders,
  legalDocumentByKind,
  type LegalKind,
} from "../legal/documents";
import "../legal/legal.css";

function goTo(event: MouseEvent<HTMLAnchorElement>, href: string, onGo: (path: string) => void) {
  event.preventDefault();
  onGo(href);
}

function RichText(props: { text: string }) {
  return (
    <span
      dangerouslySetInnerHTML={{
        __html: highlightDeveloperPlaceholders(escapeHtml(props.text)),
      }}
    />
  );
}

export function LegalScreen(props: { kind: LegalKind; onGo: (path: string) => void }) {
  const legal = legalDocumentByKind(props.kind);
  const other =
    props.kind === "privacy"
      ? { href: "/new/terms" as const, label: "Terms of Service" }
      : { href: "/new/privacy" as const, label: "Privacy Policy" };

  useEffect(() => {
    const previous = window.document.title;
    window.document.title = `${legal.title} — PackProof`;
    return () => {
      window.document.title = previous;
    };
  }, [legal.title]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => goTo(event, "/", props.onGo)}>
          <img src="/packproof-logo.png" alt="" width={28} height={28} />
          PackProof
        </a>
        <nav className="topbar-nav" aria-label="Legal">
          <a
            href="/new/privacy"
            aria-current={props.kind === "privacy" ? "page" : undefined}
            onClick={(event) => goTo(event, "/new/privacy", props.onGo)}
          >
            Privacy
          </a>
          <a
            href="/new/terms"
            aria-current={props.kind === "terms" ? "page" : undefined}
            onClick={(event) => goTo(event, "/new/terms", props.onGo)}
          >
            Terms
          </a>
          <a href="/" onClick={(event) => goTo(event, "/", props.onGo)}>
            Back to PackProof
          </a>
        </nav>
      </header>
      <main className="page page-legal">
        <p className="legal-kicker">PackProof</p>
        <h1>{legal.title}</h1>
        <p className="legal-updated">Last updated {legal.lastUpdated}</p>
        <p className="legal-lede">{legal.description}</p>
        <nav aria-label="Table of contents">
          <ol className="legal-toc">
            {legal.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="legal-doc">
          {legal.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>
                  <RichText text={paragraph} />
                </p>
              ))}
              {section.bullets ? (
                <ul>
                  {section.bullets.map((item) => (
                    <li key={item}>
                      <RichText text={item} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {section.closingParagraphs?.map((paragraph) => (
                <p key={paragraph}>
                  <RichText text={paragraph} />
                </p>
              ))}
            </section>
          ))}
        </article>
        <footer className="legal-footer">
          <a href={other.href} onClick={(event) => goTo(event, other.href, props.onGo)}>
            {other.label}
          </a>
          <a href="/" onClick={(event) => goTo(event, "/", props.onGo)}>
            Back to PackProof
          </a>
        </footer>
      </main>
    </div>
  );
}
