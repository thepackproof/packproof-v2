import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Website } from "./site/PublicSite";
import "./styles.css";
import "./site/site.css";
import "./site/refinements.css";
import "./site/experience.css";
import "./components/workspace-proof-record.css";
import "./site/proof-diagram.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

// Some hosting gateways rewrite the request hostname before the Worker sees it.
// Keep the browser on the canonical origin before initializing account state.
if (window.location.hostname === "www.thepackproof.com") {
  const canonical = new URL(window.location.href);
  canonical.hostname = "thepackproof.com";
  canonical.protocol = "https:";
  canonical.port = "";
  window.location.replace(canonical.href);
} else {
  createRoot(root).render(
    <StrictMode>
      <Website />
    </StrictMode>,
  );
}
