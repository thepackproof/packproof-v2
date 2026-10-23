import { recordPublicEvent } from "../site/analytics";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CinematicShell } from "../site/CinematicShell";
import { CinematicHome } from "../site/CinematicHome";
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it("lets a visitor stop motion and retains that choice on a later visit", async () => {
  const first=render(<CinematicShell path="/"><main id="main-content">Content</main></CinematicShell>);
  await userEvent.click(screen.getByRole("button",{name:"Pause decorative motion"}));
  expect(first.container.querySelector(".eim-site")).toHaveAttribute("data-motion","reduced");
  expect(document.documentElement.style.scrollBehavior).toBe("auto");
  expect(localStorage.getItem("packproof.motion")).toBe("reduced");
  first.unmount();
  const next=render(<CinematicShell path="/"><main id="main-content">Content</main></CinematicShell>);
  expect(next.container.querySelector(".eim-site")).toHaveAttribute("data-motion","reduced");
});
it("honors the operating system preference even when saved settings permit motion", () => {
  localStorage.setItem("packproof.motion","full");
  vi.stubGlobal("matchMedia",() => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  const {container}=render(<CinematicShell path="/"><main id="main-content">Content</main></CinematicShell>);
  expect(container.querySelector(".eim-site")).toHaveAttribute("data-motion","reduced");
  expect(screen.getByRole("button",{name:"Motion reduced by system preference"})).toBeDisabled();
});
it("opens mobile navigation and returns keyboard focus to its control on Escape", async () => {
  render(<CinematicShell path="/"><main id="main-content">Content</main></CinematicShell>);
  const button=screen.getByRole("button",{name:"Open navigation"});
  await userEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded","true");
  await userEvent.keyboard("{Escape}");
  expect(button).toHaveAttribute("aria-expanded","false");
  expect(button).toHaveFocus();
});
it("connects keyboard source selection to the explanatory panel", async () => {
  render(<CinematicHome/>);
  const list=screen.getByRole("tablist",{name:"Sources connected to a Proof"});
  within(list).getByRole("tab",{name:/Order/}).focus();
  await userEvent.keyboard("{End}");
  const shipping=within(list).getByRole("tab",{name:/Shipping/});
  expect(shipping).toHaveFocus();
  expect(shipping).toHaveAttribute("aria-selected","true");
  expect(screen.getByRole("tabpanel",{name:/Shipping/})).toHaveTextContent("Tracking depends on the shipment and provider.");
});



it("records public CTA engagement on canonical trailing-slash routes without identifiers", async () => {
  const fetch=vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit)=>new Response("{}",{status:200}));
  vi.stubGlobal("fetch",fetch);
  recordPublicEvent("CTA_CLICK","/sellers/");
  expect(fetch).toHaveBeenCalledOnce();
  const init=fetch.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({event:"CTA_CLICK",path:"/sellers",device:"tablet"});
  expect(init.credentials).toBe("omit");
  expect(init.referrerPolicy).toBe("no-referrer");
});
it("does not send public analytics when a visitor enables Global Privacy Control", () => {
  const fetch=vi.fn();
  vi.stubGlobal("fetch",fetch);
  vi.stubGlobal("navigator",{globalPrivacyControl:true});
  recordPublicEvent("CTA_CLICK","/sellers/");
  expect(fetch).not.toHaveBeenCalled();
});


