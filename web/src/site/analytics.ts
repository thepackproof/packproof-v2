import { defaultApiBaseUrl } from "../auth/session";

type Event = "PAGE_VIEW"|"SIGNUP_STARTED"|"CTA_CLICK"|"APP_STORE_CLICK"|"PLAY_STORE_CLICK"|"LOGIN_CLICK";
const publicPaths=new Set(["/","/about","/contact","/pricing","/login","/signup","/register","/download","/how-it-works","/evidence-integrity","/reviewers","/integrations","/platform-api","/sellers","/buyers","/security","/sample","/proof-anywhere","/privacy","/terms"]);
let lastPage="";
function analyticsPath(path:string){if(path==="/signup")return "/register";if(path==="/sample")return "/proof";return path;}
/** Anonymous aggregate counts only. No cookies, persistent identifiers, URL
 * parameters, account tokens, or referrer strings leave this module. */
export function recordPublicEvent(event:Event,path=window.location.pathname){
  if(!publicPaths.has(path)||navigator.doNotTrack==="1"||(navigator as Navigator&{globalPrivacyControl?:boolean}).globalPrivacyControl)return;
  const device=window.innerWidth<768?"mobile":window.innerWidth<1100?"tablet":"desktop";
  void fetch(`${defaultApiBaseUrl().replace(/\/$/,"")}/analytics/events`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event,path:analyticsPath(path),device}),credentials:"omit",referrerPolicy:"no-referrer",keepalive:true}).catch(()=>{});
}
export function observePublicPage(path:string){if(path===lastPage)return;lastPage=path;recordPublicEvent("PAGE_VIEW",path);}
export function installPublicAnalytics(){
  const click=(event:MouseEvent)=>{const link=(event.target as Element|null)?.closest?.("a");if(!link)return;let destination:URL;try{destination=new URL(link.href,window.location.origin);}catch{return;}
    if(destination.hostname==="apps.apple.com")recordPublicEvent("APP_STORE_CLICK");
    else if(destination.hostname==="play.google.com")recordPublicEvent("PLAY_STORE_CLICK");
    else if(destination.origin===window.location.origin&&["/signup","/register"].includes(destination.pathname))recordPublicEvent("SIGNUP_STARTED");
    else if(destination.origin===window.location.origin&&destination.pathname==="/login")recordPublicEvent("LOGIN_CLICK");
    else if(link.matches(".pp-button,.site-button,.pp-actions a"))recordPublicEvent("CTA_CLICK");
  };document.addEventListener("click",click);return()=>document.removeEventListener("click",click);
}
