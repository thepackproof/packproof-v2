import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { installPublicAnalytics, observePublicPage } from "./analytics";
import { installNavigationContext } from "../navigation-context";
import { SampleProof } from "./SampleProof";
import { CinematicShell, publicPageTitles } from "./CinematicShell";
import { CinematicHome } from "./CinematicHome";
import { CinematicPage } from "./CinematicPages";
import { legalDocumentByKind } from "../legal/documents";
import { Brand, Glyph } from "./Brand";
export { Brand, Glyph } from "./Brand";
const App = lazy(() => import("../App").then(module => ({ default: module.App })));
function Eyebrow({children,light=false}:{children:ReactNode;light?:boolean}){return <p className={light ? "site-eyebrow light" : "site-eyebrow"}><span/>{children}</p>;}
function CTA(){return <section className="closing-cta site-width"><div><Eyebrow light>YOUR NEXT SHIPMENT, DOCUMENTED.</Eyebrow><h2>Capture the process.<br/>Show the Proof.</h2></div><div><a className="site-button eim-button" href="/signup">Create your account <Glyph/></a><p>One order. One connected record.</p></div></section>;}
export function SampleRecord({large=false}:{large?:boolean}){return <SampleProof compact={!large}/>;}
function Contact() {
  const [prepared,setPrepared] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const topic = String(data.get("topic")); const body = `Name: ${data.get("name")}\nEmail: ${data.get("email")}\n\n${data.get("message")}`; window.location.href = `mailto:admin@thepackproof.com?subject=${encodeURIComponent(`PackProof — ${topic}`)}&body=${encodeURIComponent(body)}`; setPrepared(true); }
  return <section className="contact-grid site-width page-intro"><div><Eyebrow>GET IN TOUCH</Eyebrow><h1>Let’s talk<br /><span>PackProof.</span></h1><p>A question, an idea, or a workflow you’d like to improve? We’d like to hear it.</p><a className="contact-email" href="mailto:admin@thepackproof.com"><Glyph name="mail" />admin@thepackproof.com</a><div className="contact-note"><span className="status-dot" /><p>Product questions, partnerships,<br />and thoughtful feedback welcome.</p></div></div><form className="contact-form" onSubmit={submit}><h2>What’s on your mind?</h2><div className="form-pair"><label>Your name<input name="name" autoComplete="name" placeholder="Alex Morgan" required maxLength={120} /></label><label>Email address<input name="email" type="email" autoComplete="email" placeholder="alex@company.com" required maxLength={254} /></label></div><label>How can we help?<select name="topic"><option>Product question</option><option>Account support</option><option>Partnership</option><option>Feedback</option></select></label><label>Your message<textarea name="message" placeholder="Tell us a little about what you have in mind…" required rows={5} maxLength={4000} /></label><button className="site-button navy" type="submit">Open email draft <Glyph /></button><p className="form-explanation" role="status">{prepared ? "Your email draft is ready in your email app. Review it and press Send there. If it did not open, use the email address on this page." : "Opens your email app with a prepared message. Nothing is sent until you choose to send it."}</p></form></section>;
}

function Legal({ kind }: { kind: "privacy" | "terms" }) { const doc = legalDocumentByKind(kind); return <section className="public-legal site-width"><div className="page-intro"><Eyebrow>THE DETAILS</Eyebrow><h1>{doc.title}</h1><p>{doc.description}</p><span className="legal-date">Last updated {doc.lastUpdated}</span><p className="legal-draft">Draft for review. Company details and legal contact information still need to be confirmed before public launch.</p></div><div className="legal-layout"><nav aria-label="On this page"><span className="micro-label">ON THIS PAGE</span>{doc.sections.map(s => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}</nav><article>{doc.sections.map(s => <section id={s.id} key={s.id}><h2>{s.title}</h2>{s.paragraphs.map(p => <p key={p}>{p}</p>)}{s.bullets && <ul>{s.bullets.map(p => <li key={p}>{p}</li>)}</ul>}{s.closingParagraphs?.map(p => <p key={p}>{p}</p>)}</section>)}</article></div></section>; }

function Demo() { return <><section className="page-intro site-width sample-intro"><Eyebrow>INTERACTIVE SAMPLE · NO CUSTOMER DATA</Eyebrow><h1>Open the record.<br/><span>Go straight to the evidence.</span></h1><p>Play an illustrative packing clip, jump to a source moment, inspect the timeline, and review a sample buyer receipt or case packet.</p></section><section className="demo-stage site-width"><div className="demo-sidebar"><Brand/><span className="micro-label">SAMPLE PROOF</span><p>Fictional order #1042<br/>One ceramic mug</p><p>No real delivery, customer, or PackProof capture is represented.</p><a className="site-button navy small" href="/signup">Create a real Proof <Glyph size={16}/></a></div><div className="demo-main"><SampleRecord large/><p className="demo-caption">This uses the same evidence player, timeline and tracking components as the workspace. Sample actions stay within this fictional record.</p></div></section><CTA/></>; }

export function AuthFrame({ children }: { children: ReactNode }) { return <div className="auth-experience"><div className="auth-story"><Brand dark /><div><Eyebrow light>WELCOME TO YOUR WORKSPACE</Eyebrow><h2>Every detail.<br />In good hands.</h2><p>A place for your orders, your evidence,<br />and a clearer record of every shipment.</p></div><img src="/packproof-hero.png" alt="Carefully sealed package" width="1536" height="1024" /><span className="auth-caption"><span className="status-dot" /> From packed to preserved.</span></div><div className="auth-form-panel"><a className="auth-back" href="/">← Back to PackProof</a>{children}<div className="auth-assistance">Need a hand? <a href="/contact">Get in touch</a></div></div></div>; }


function currentPath() { return window.location.pathname.replace(/\/$/, "") || "/"; }
const cinematicPaths = new Set(["/how-it-works","/evidence-integrity","/sellers","/buyers","/reviewers","/platform-api","/integrations","/about","/security","/proof-anywhere","/download"]);
const publicPaths = new Set(["/", ...cinematicPaths, "/sample","/contact","/privacy","/terms","/new/privacy","/new/terms"]);
export function Website() {
  const [path,setPath] = useState(currentPath);
  useEffect(installPublicAnalytics, []);
  useEffect(() => { observePublicPage(path); }, [path]);
  useEffect(installNavigationContext, []);
  useEffect(() => {
    const update = () => setPath(currentPath());
    window.addEventListener("popstate",update); window.addEventListener("packproof:navigate",update);
    return () => { window.removeEventListener("popstate",update); window.removeEventListener("packproof:navigate",update); };
  },[]);
  useEffect(() => {
    const title = publicPageTitles[path] ?? ({"/login":"Log in","/signup":"Create an account","/app":"Your workspace"} as Record<string,string>)[path] ?? "Your workspace";
    document.title = title + " — PackProof";
  },[path]);
  if (!publicPaths.has(path) && /^\/(app|home|overview|orders|uploads|notifications|login|signup|sample-proof|proofs|new|scan|activity|account|capture|developer|admin|receipt|invitations|fulfillment|station|pack|stores|p)(\/|$)/.test(path)) {
    return <Suspense fallback={<main className="app-loading" role="status"><Brand/><p>Opening PackProof…</p></main>}><App authInitialView={path === "/signup" ? "create-account" : "sign-in"}/></Suspense>;
  }
  return <CinematicShell path={path}>{path === "/" ? <CinematicHome/> :
    cinematicPaths.has(path) ? <main id="main-content"><CinematicPage path={path}/></main> :
    <main id="main-content" className="public-site eim-legacy-content">{
      path === "/sample" ? <Demo/> : path === "/contact" ? <Contact/> :
      ["/privacy","/new/privacy","/terms","/new/terms"].includes(path) ? <Legal kind={path.endsWith("privacy") ? "privacy" : "terms"}/> :
      <section className="page-intro site-width"><Eyebrow>PAGE NOT FOUND</Eyebrow><h1>This one’s<br/>off the route.</h1><p>Let’s get you back to a clearer path.</p><a href="/" className="eim-button site-button">Back to PackProof <Glyph/></a></section>
    }</main>}
  </CinematicShell>;
}

