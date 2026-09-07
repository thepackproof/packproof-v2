import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Website } from "../site/PublicSite";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

it("loads the actual sign-in screen through the split application entry", async () => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/login");
  render(<Website />);
  // Cold transformation of the lazy app entry can overlap the other CI suites.
  expect(await screen.findByRole("heading", { name: "Welcome back." }, {timeout:4000})).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute("aria-selected", "true");
});

it("exposes the illustrative tracking and timeline controls in the public sample", async () => {
  window.history.replaceState({}, "", "/sample");
  render(<Website />);
  await userEvent.click(screen.getByRole("button", { name: "Tracking" }));
  expect(screen.getByText("Illustrative data · not a real shipment")).toBeInTheDocument();
  expect(screen.getByTitle(/Map of reported location: Columbus/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
  expect(screen.getByText("Integrity event")).toBeInTheDocument();
  expect(screen.queryByTitle(/Map of reported location/)).not.toBeInTheDocument();
});
