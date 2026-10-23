import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { CinematicShell, publicPageTitles } from "./src/site/CinematicShell";
import { CinematicHome } from "./src/site/CinematicHome";
import { CinematicPage } from "./src/site/CinematicPages";
const pages = new Set(["/","/how-it-works","/evidence-integrity","/sellers","/buyers","/reviewers","/platform-api","/integrations","/about","/security","/proof-anywhere","/download"]);
function readRoute(){const hash=window.location.hash;return hash.startsWith("#/") ? hash.slice(1).replace(/\/$/,"") || "/" : "/";}
function Preview(){
  const [path,setPath]=useState(readRoute);
  useEffect(()=>{
    const update=()=>setPath(readRoute());
    const click=(event:MouseEvent)=>{
      const link=(event.target as Element)?.closest?.("a");
      const href=link?.getAttribute("href");
      if(!link || !href || !href.startsWith("/") || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
      const destination=new URL(href,"https://thepackproof.com");
      const next=destination.pathname.replace(/\/$/,"")||"/";
      if(pages.has(next)){
        event.preventDefault(); history.pushState({},"","#"+next); setPath(next); window.scrollTo({top:0,behavior:"instant" as ScrollBehavior});
      }else{link.href=destination.href;}
    };
    window.addEventListener("popstate",update);document.addEventListener("click",click);
    return()=>{window.removeEventListener("popstate",update);document.removeEventListener("click",click);};
  },[]);
  useEffect(()=>{document.title=(publicPageTitles[path]||"Design preview")+" — PackProof";},[path]);
  return <CinematicShell path={path}>{path==="/" ? <CinematicHome/> : <main id="main-content"><CinematicPage path={path}/></main>}</CinematicShell>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);

