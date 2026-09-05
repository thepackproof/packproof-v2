import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

type Context = { y: number; anchor?: string; offset?: number; focus?: string };
const prefix = "packproof.view.";
let activeKey = "";
let restoring = false;
let cleanup: (() => void) | undefined;
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(sessionStorage.getItem(prefix + key) || "null") ?? fallback; } catch { return fallback; } };
const write = (key: string, value: unknown) => { try { sessionStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* Navigation remains available without storage. */ } };
export function useViewState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  useEffect(() => write(key, value), [key, value]);
  return [value, setValue];
}
function contextKey() { return window.history.state?.ppContext || window.location.pathname + window.location.search; }
export function saveNavigationContext() {
  if (!activeKey || restoring) return;
  const anchors = [...document.querySelectorAll<HTMLElement>("[data-context-anchor]")];
  const anchor = anchors.find(el => el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight);
  const focused = document.activeElement as HTMLElement | null;
  write(activeKey, { y: window.scrollY, anchor: anchor?.dataset.contextAnchor, offset: anchor?.getBoundingClientRect().top,
    focus: focused?.id || focused?.dataset.contextAnchor } satisfies Context);
}
export function restoreNavigationContext() {
  cleanup?.();
  activeKey = contextKey();
  const saved = read<Context>(activeKey, { y: 0 });
  restoring = true;
  let done = false;
  const finish = () => { done = true; restoring = false; observer.disconnect(); clearTimeout(timeout); };
  const apply = () => {
    if (done) return;
    const anchor = saved.anchor ? [...document.querySelectorAll<HTMLElement>("[data-context-anchor]")].find(el => el.dataset.contextAnchor === saved.anchor) : null;
    if (saved.anchor && !anchor) return;
    window.scrollTo?.({ top: anchor ? window.scrollY + anchor.getBoundingClientRect().top - (saved.offset || 0) : saved.y, behavior: "instant" as ScrollBehavior });
    const focus = saved.focus ? document.getElementById(saved.focus) || [...document.querySelectorAll<HTMLElement>("[data-context-anchor]")].find(el => el.dataset.contextAnchor === saved.focus) : null;
    focus?.focus({ preventScroll: true });
    finish();
  };
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true });
  const timeout = window.setTimeout(() => { if (!done) { window.scrollTo?.(0, saved.y); finish(); } }, 4000);
  const frame = requestAnimationFrame(apply);
  cleanup = () => { cancelAnimationFrame(frame); finish(); };
}
export function installNavigationContext() {
  const original = window.history.scrollRestoration;
  window.history.scrollRestoration = "manual";
  if (!window.history.state?.ppContext) window.history.replaceState({ ...window.history.state, ppContext: crypto.randomUUID() }, "");
  activeKey = contextKey();
  window.addEventListener("scroll", saveNavigationContext, { passive: true });
  window.addEventListener("pagehide", saveNavigationContext);
  const resume = () => restoreNavigationContext();
  window.addEventListener("popstate", resume);
  window.addEventListener("packproof:navigate", resume);
  return () => { cleanup?.(); window.history.scrollRestoration = original; window.removeEventListener("scroll", saveNavigationContext); window.removeEventListener("pagehide", saveNavigationContext); window.removeEventListener("popstate", resume); window.removeEventListener("packproof:navigate", resume); };
}
export function clearViewState() { try { Object.keys(sessionStorage).filter(k => k.startsWith(prefix)).forEach(k => sessionStorage.removeItem(k)); } catch { /* No persistent state to remove. */ } }
