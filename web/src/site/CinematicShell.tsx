import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { loadSession } from "../auth/session";
import { Glyph } from "./Brand";
import "./cinematic-shell.css";

export const publicPageTitles: Record<string, string> = {
  "/": "Capture the process. Show the Proof.", "/how-it-works": "How PackProof works",
  "/evidence-integrity": "Evidence integrity", "/sellers": "For sellers", "/buyers": "For buyers",
  "/reviewers": "For reviewers", "/platform-api": "Platform & API", "/integrations": "Connections & integrations",
  "/about": "About PackProof", "/security": "Security & responsible evidence", "/proof-anywhere": "Check an exported Proof",
  "/download": "Take PackProof with you", "/sample": "Explore a sample Proof", "/contact": "Contact PackProof",
  "/privacy": "Privacy policy", "/terms": "Terms of service", "/new/privacy": "Privacy policy", "/new/terms": "Terms of service",
};
const productLinks = [
  { href: "/how-it-works/", title: "The workflow", copy: "From order to organized evidence.", icon: "box" },
  { href: "/sample/", title: "A living Proof", copy: "Open an interactive sample record.", icon: "film" },
  { href: "/evidence-integrity/", title: "Evidence integrity", copy: "Understand exactly what is preserved.", icon: "shield" },
  { href: "/platform-api/", title: "Platform & API", copy: "Build evidence into your workflow.", icon: "code" },
];
function useMotionPreference() {
  const [paused, setPaused] = useState(() => {
    try { return localStorage.getItem("packproof.motion") === "reduced"; } catch { return false; }
  });
  const [systemReduced, setSystemReduced] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false));
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const changed = () => setSystemReduced(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return {
    reduced: paused || systemReduced, systemReduced,
    toggle: () => setPaused(value => {
      try { localStorage.setItem("packproof.motion", value ? "full" : "reduced"); } catch { /* A preference must never prevent navigation. */ }
      return !value;
    }),
  };
}
/** Native scrolling, visible fallback content and mount-owned observers. */
function useSceneMotion(root: RefObject<HTMLDivElement | null>, reduced: boolean, path: string) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const scenes = [...element.querySelectorAll<HTMLElement>("[data-scene]")];
    const reveals = [...element.querySelectorAll<HTMLElement>("[data-reveal]")];
    let frame = 0;
    const active = new Set<HTMLElement>();
    const update = () => {
      frame = 0;
      if (document.hidden) return;
      const height = window.innerHeight;
      for (const scene of active) {
        const bounds = scene.getBoundingClientRect();
        const progress = Math.max(0, Math.min(1, (height - bounds.top) / (height + bounds.height)));
        scene.style.setProperty("--scene-progress", progress.toFixed(4));
      }
      element.dataset.scrolled = String(window.scrollY > 48);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    if (reduced || !("IntersectionObserver" in window)) {
      scenes.forEach(scene => { scene.style.setProperty("--scene-progress", ".5"); scene.classList.add("is-in-view"); });
      reveals.forEach(reveal => reveal.classList.add("is-visible"));
      element.classList.remove("eim-ready");
      element.dataset.scrolled = String(window.scrollY > 48);
      window.addEventListener("scroll", schedule, { passive: true });
      return () => { window.removeEventListener("scroll", schedule); cancelAnimationFrame(frame); };
    }
    const sceneObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const scene = entry.target as HTMLElement;
        scene.classList.toggle("is-in-view", entry.isIntersecting);
        if (entry.isIntersecting) active.add(scene); else active.delete(scene);
      }); schedule();
    }, { rootMargin: "160px 0px" });
    const revealObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add("is-visible"); revealObserver.unobserve(entry.target); }
      });
    }, { threshold: .08, rootMargin: "0px 0px -20px 0px" });
    scenes.forEach(scene => { active.add(scene); sceneObserver.observe(scene); });
    reveals.forEach(reveal => {
      if (reveal.getBoundingClientRect().top < window.innerHeight) reveal.classList.add("is-visible"); else revealObserver.observe(reveal);
    });
    element.classList.add("eim-ready"); update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelAnimationFrame(frame); sceneObserver.disconnect(); revealObserver.disconnect();
      window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule); element.classList.remove("eim-ready");
    };
  }, [root, reduced, path]);
}
function Wordmark({ footer = false }: { footer?: boolean }) {
  return <a className={footer ? "eim-brand eim-brand-footer" : "eim-brand"} href="/" aria-label="PackProof home">
    <img src="/brand/packproof-symbol-reversed.svg" width="36" height="36" alt="" />
    <img className="eim-wordmark" src="/brand/packproof-wordmark-reversed.svg" width="139" height="30" alt="PackProof" />
  </a>;
}
function CinematicHeader({ path, reduced, systemReduced, toggle }: { path: string; reduced: boolean; systemReduced: boolean; toggle: () => void }) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const product = useRef<HTMLDetailsElement>(null);
  const signedIn = Boolean(loadSession());
  useEffect(() => { setOpen(false); if (product.current) product.current.open = false; }, [path]);
  useEffect(() => { if (open) { if (product.current && window.matchMedia?.("(max-width: 900px)").matches) product.current.open = true; nav.current?.querySelector<HTMLAnchorElement>("a")?.focus(); } }, [open]);
  function close() { const wasOpen = open; const productWasOpen = product.current?.open; setOpen(false); if (product.current) product.current.open = false; if (wasOpen) menuButton.current?.focus(); else if (productWasOpen) product.current?.querySelector<HTMLElement>("summary")?.focus(); }
  return <header className="eim-header" onKeyDown={event => { if (event.key === "Escape") close(); }}>
    <div className="eim-nav-bar"><Wordmark />
      <nav ref={nav} id="eim-navigation" className={open ? "eim-navigation is-open" : "eim-navigation"} aria-label="Main navigation">
        <details className="eim-product-menu" ref={product}><summary>Product <Glyph name="chevron" size={14} /></summary>
          <div className="eim-mega-menu">{productLinks.map(link => <a key={link.href} href={link.href}><span className="eim-nav-icon"><Glyph name={link.icon} /></span><span><strong>{link.title}</strong><small>{link.copy}</small></span><Glyph size={16} /></a>)}<div className="eim-menu-note"><span className="eim-status-dot" /> One order. One connected record.</div></div>
        </details>
        <a href="/sellers/" aria-current={path === "/sellers" ? "page" : undefined}>For sellers</a>
        <a href="/about/" aria-current={path === "/about" ? "page" : undefined}>Our story</a>
        <a href="/contact/" aria-current={path === "/contact" ? "page" : undefined}>Contact</a>
        <a className="eim-mobile-login" href={signedIn ? "/app" : "/login"}>{signedIn ? "Your workspace" : "Log in"}<Glyph size={16} /></a>
      </nav>
      <div className="eim-nav-actions">
        <button className="eim-motion-control" type="button" onClick={toggle} aria-label={systemReduced ? "Motion reduced by system preference" : reduced ? "Enable decorative motion" : "Pause decorative motion"} aria-pressed={reduced} disabled={systemReduced} title={systemReduced ? "Your system preference reduces motion" : reduced ? "Turn on decorative motion" : "Pause decorative motion"}><span aria-hidden="true">{reduced ? "Ⅱ" : "◉"}</span><span>{reduced ? "Motion off" : "Motion on"}</span></button>
        <a className="eim-login" href={signedIn ? "/app" : "/login"}>{signedIn ? "Workspace" : "Log in"}</a>
        <a className="eim-button eim-button-small site-button" href={signedIn ? "/new" : "/signup"}>Get started <Glyph size={16} /></a>
        <button ref={menuButton} className="eim-menu-toggle" type="button" aria-label={open ? "Close navigation" : "Open navigation"} aria-controls="eim-navigation" aria-expanded={open} onClick={() => setOpen(value => !value)}><Glyph name={open ? "close" : "menu"} size={24} /></button>
      </div>
    </div>
  </header>;
}
function CinematicFooter() {
  return <footer className="eim-footer">
    <div className="eim-footer-top"><div><Wordmark footer /><p>Neutral evidence infrastructure<br />for e-commerce.</p><a className="eim-footer-contact" href="mailto:admin@thepackproof.com">Let’s build a clearer record <Glyph size={17} /></a></div>
      <div className="eim-footer-column"><h2>Explore</h2><a href="/how-it-works/">How it works</a><a href="/sample/">Sample Proof</a><a href="/evidence-integrity/">Evidence integrity</a><a href="/proof-anywhere/">Independent verification</a><a href="/download/">Get PackProof</a></div>
      <div className="eim-footer-column"><h2>Built for</h2><a href="/sellers/">Sellers</a><a href="/buyers/">Buyers</a><a href="/reviewers/">Reviewers</a><a href="/platform-api/">Platforms & developers</a><a href="/integrations/">Connections</a></div>
      <div className="eim-footer-column"><h2>PackProof</h2><a href="/about/">Our story</a><a href="/contact/">Contact</a><a href="/security/">Security</a><a href="https://thepackproof.com/evidence-library/">Evidence Library <span aria-hidden="true">↗</span></a><a href="/evidence-library/editorial-method/">Editorial method</a><a href="/investors">Investor deck</a><div className="eim-social-links"><a href="https://x.com/packproof" target="_blank" rel="noreferrer" aria-label="PackProof on X">X</a><a href="https://facebook.com/packproof" target="_blank" rel="noreferrer" aria-label="PackProof on Facebook">Fb</a><a href="https://instagram.com/thepackproof" target="_blank" rel="noreferrer" aria-label="PackProof on Instagram">Ig</a></div></div>
    </div>
    <div className="eim-footer-bottom"><span>© {new Date().getFullYear()} PackProof</span><span className="eim-footer-neutral">The record informs. People decide.</span><div><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></div></div>
    <div className="eim-footer-type" aria-hidden="true">SHOW THE PROOF.</div>
  </footer>;
}
export function CinematicShell({ path, children }: { path: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const motion = useMotionPreference();
  useSceneMotion(root, motion.reduced, path);
  useEffect(() => { const previous = document.documentElement.style.scrollBehavior; if (motion.reduced) document.documentElement.style.scrollBehavior = "auto"; return () => { document.documentElement.style.scrollBehavior = previous; }; }, [motion.reduced]);
  return <div className="eim-site" ref={root} data-motion={motion.reduced ? "reduced" : "full"}>
    <a className="eim-skip-link" href="#main-content">Skip to content</a>
    <CinematicHeader path={path} {...motion} />{children}<CinematicFooter />
  </div>;
}




