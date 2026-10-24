import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedReview } from "../site/UnifiedReview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("preserves the selected source and its exception when bringing separate records together", async () => {
  const requests = vi.fn();
  vi.stubGlobal("fetch", requests);
  render(<UnifiedReview />);
  await userEvent.click(screen.getByRole("button", { name: /Dispatch log/ }));
  const inspector = screen.getByRole("heading", { name: "Dispatch log" }).closest(".ur-inspector")!;
  expect(within(inspector as HTMLElement).getByText("Order reference differs")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Bring the record together" }));
  expect(screen.getByRole("status")).toHaveTextContent("Five attributed sources form one chronology, with two review exceptions.");
  expect(screen.getByRole("button", { name: /Dispatch log/ })).toHaveAttribute("aria-pressed", "true");
  expect(inspector).toHaveTextContent("dispatch-batch.csv");
  const record = screen.getByLabelText("Connected illustrative shipment record");
  expect(record).toHaveFocus();
  expect(within(record).getByText("Order reference differs")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Scattered sources" }));
  expect(screen.queryByLabelText("Connected illustrative shipment record")).not.toBeInTheDocument();
  expect(inspector).toHaveTextContent("dispatch-batch.csv");
  expect(requests).not.toHaveBeenCalled();
});

it("lets keyboard visitors inspect evidence gaps and keeps pilot claims qualified", async () => {
  render(<UnifiedReview />);
  await userEvent.click(screen.getByRole("button", { name: /Order system/ }));
  const source = screen.getByRole("button", { name: /Packing camera/ });
  source.focus();
  await userEvent.keyboard("{Enter}");
  const inspector = screen.getByRole("heading", { name: "Packing camera" }).closest(".ur-inspector")!;
  expect(inspector).toHaveTextContent("Final seal not shown");
  expect(inspector).toHaveTextContent("packing-1042.mp4");
  expect(screen.getByText(/All records and exceptions above are fictional/)).toBeInTheDocument();
  expect(screen.getByText(/measure review time and unresolved gaps against your current process/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Discuss a pilot" })).toHaveAttribute("href", "mailto:admin@thepackproof.com?subject=PackProof%20historical%20shipment%20pilot");
});
