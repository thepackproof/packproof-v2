import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Website } from "../site/PublicSite";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it("opens and closes the read-only first-Proof sample through the production website without an account", async () => {
  vi.stubEnv('VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE', 'true');
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
  const requests = vi.fn(async (_url: RequestInfo | URL) => new Response('{}', {headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch', requests);
  history.replaceState({}, '', '/login');
  render(<Website />);
  await userEvent.click(await screen.findByRole('button', {name:'See a sample Proof'}, {timeout:4000}));
  expect(await screen.findByRole('heading', {name:'See a sample Proof'})).toBeInTheDocument();
  expect(location.pathname).toBe('/sample-proof');
  expect(screen.queryByText('PAGE NOT FOUND')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name:'More actions'})).not.toBeInTheDocument();
  expect(requests.mock.calls.every(([url]) => String(url).endsWith('/analytics/events'))).toBe(true);
  await userEvent.click(screen.getByRole('button', {name:'Close sample'}));
  expect(await screen.findByRole('heading', {name:'Welcome back.'})).toBeInTheDocument();
  expect(location.pathname).toBe('/login');
});

it("loads the actual sign-in screen through the split application entry", async () => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/login");
  render(<Website />);
  // Cold transformation of the lazy app entry can overlap the other CI suites.
  expect(await screen.findByRole("heading", { name: "Welcome back." }, {timeout:4000})).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute("aria-selected", "true");
});

it("exposes canonical record tabs with illustrative tracking and activity in the public sample", async () => {
  window.history.replaceState({}, "", "/sample");
  render(<Website />);
  await userEvent.click(screen.getByRole("tab", { name: "Tracking" }));
  expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Recording", "Activity", "Tracking"]);
  expect(screen.getByRole("tab", { name: "Tracking" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Illustrative data · not a real shipment")).toBeInTheDocument();
  expect(screen.getByTitle(/Map of reported location: Columbus/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Integrity event")).toBeInTheDocument();
  expect(screen.queryByTitle(/Map of reported location/)).not.toBeInTheDocument();
});
