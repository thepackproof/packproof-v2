import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeScreen } from "../screens/HomeScreen";
import { summary } from "./fixtures";
import type { LocalRecordingSummary } from '../capture-queue';

vi.mock('../mobile-task/task-state', async original => ({ ...await original<typeof import('../mobile-task/task-state')>(), usableSavedRecording: vi.fn(async () => true) }));

afterEach(cleanup);

const props = () => ({
  proofs: [summary], queue: [], connections: [], loading: false, error: null,
  onRetry: vi.fn(), onGo: vi.fn(), onOpenProof: vi.fn(), onOpenInvitation: vi.fn(), onOpenReceiver: vi.fn(),
});

it("uses canonical completion facts and leaves an unavailable upload count unknown", () => {
  render(<HomeScreen {...props()} proofs={[
    { ...summary, proofId: "unfinished", status: "FINALIZED", finalizedAt: null },
    { ...summary, proofId: "completed", status: "FINALIZED", finalizedAt: "2026-10-01T12:00:00Z" },
  ]} />);
  const metrics = screen.getByRole("region", { name: "Workspace summary" });
  expect(within(metrics).getByRole("button", { name: /Completed Proofs/ })).toHaveTextContent("Completed Proofs1");
  expect(within(metrics).getByRole("button", { name: /Pending uploads/ })).toHaveTextContent("Pending uploads—");
  expect(screen.getByRole("button", { name: "Review uploads" })).toBeInTheDocument();
  expect(screen.queryByText("Protected")).not.toBeInTheDocument();
});

it("keeps a failed workspace load distinct from empty collections and retries", async () => {
  const callbacks = props();
  render(<HomeScreen {...callbacks} proofs={[]} error="Network unavailable" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable");
  expect(screen.queryByText("No Proofs yet")).not.toBeInTheDocument();
  expect(screen.queryByText("No orders in this view")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(callbacks.onRetry).toHaveBeenCalledOnce();
});

it("routes receiver records and workstation actions to their existing flows", async () => {
  const callbacks = props();
  render(<HomeScreen {...callbacks} pendingUploadCount={2} proofs={[
    { ...summary, accessKind: "RECEIVER", invitationId: "receipt:proof" },
  ]} />);
  await userEvent.click(screen.getByRole("button", { name: /Vintage camera. Invitation received/ }));
  expect(callbacks.onOpenReceiver).toHaveBeenCalledWith(summary.proofId);
  expect(callbacks.onOpenInvitation).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Open Packing Station" }));
  expect(callbacks.onGo).toHaveBeenLastCalledWith("/station");
  await userEvent.click(screen.getByRole("button", { name: /Ready to fulfill/ }));
  expect(callbacks.onGo).toHaveBeenLastCalledWith("/fulfillment");
  await userEvent.click(screen.getByRole("button", { name: "2 pending" }));
  expect(callbacks.onGo).toHaveBeenLastCalledWith("/uploads");
});

const adaptive = () => ({ ...props(), firstExperience: true, reconciled: true, taskScope: 'api:user_seller', recordings: [] as LocalRecordingSummary[], pendingUploadCount: 0, onTaskAction: vi.fn() });
const local = (extra: Partial<LocalRecordingSummary> = {}): LocalRecordingSummary => ({ key: 'saved', proofId: summary.proofId, kind: 'station', file: new Blob(['fixture'], { type: 'video/webm' }), available: true, accepted: true, committed: false, finalized: false, preserved: false, ...extra });
it('keeps the desktop workspace sections while prioritizing an incomplete Proof', async () => {
  const p = adaptive(); render(<HomeScreen {...p} />);
  const hero = screen.getByRole('region', { name: 'Recommended action' });
  await userEvent.click(within(hero).getByRole('button', { name: 'Record packing' }));
  expect(p.onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'continue_proof', targetId: summary.proofId }));
  expect(screen.getByRole('heading', { name: 'Recent Proofs' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Workspace status' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Fulfillment queue' })).toBeInTheDocument();
  expect(within(hero).getByRole('button', { name: 'Create Proof' })).toBeInTheDocument();
});
it('puts a failed upload ahead of saved review and new packing', async () => {
  const p = adaptive();
  const second = { ...summary, proofId: 'second' };
  const view = render(<HomeScreen {...p} proofs={[summary, second]} recordings={[local({ accepted: false }), local({ key: 'failed', proofId: 'second', retryStopped: true })]} pendingUploadCount={2} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve upload' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Resolve upload' }));
  expect(p.onTaskAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'review_upload', sessionId: 'failed', targetId: 'second' }));
  view.rerender(<HomeScreen {...p} recordings={[local({ retryStopped: true })]} pendingUploadCount={1} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resolve upload' }));
  expect(p.onTaskAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'review_upload', sessionId: 'saved' }));
});
it('leaves healthy uploads passive and never offers capture for a viewer-only row', () => {
  const p = adaptive(), second = { ...summary, proofId: 'second' };
  const view = render(<HomeScreen {...p} proofs={[summary, second]} recordings={[local({ active: true })]} pendingUploadCount={1} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record packing' }));
  expect(p.onTaskAction).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: second.proofId }));
  view.rerender(<HomeScreen {...p} proofs={[{ ...summary, role: 'BUYER' }]} />);
  expect(screen.queryByRole('button', { name: 'Record packing' })).not.toBeInTheDocument();
});
it('keeps a focused valid target stable, then drops it when permissions change', () => {
  const p = adaptive(), second = { ...summary, proofId: 'second', createdAt: '2026-10-01T00:00:00Z' };
  const view = render(<HomeScreen {...p} proofs={[summary, second]} />);
  fireEvent.focus(screen.getByRole('button', { name: 'Record packing' }));
  view.rerender(<HomeScreen {...p} proofs={[summary, second]} taskSelection='second' />);
  fireEvent.click(screen.getByRole('button', { name: 'Record packing' }));
  expect(p.onTaskAction).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: summary.proofId }));
  view.rerender(<HomeScreen {...p} proofs={[{ ...summary, role: 'BUYER' }, second]} taskSelection='second' />);
  fireEvent.click(screen.getByRole('button', { name: 'Record packing' }));
  expect(p.onTaskAction).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: second.proofId }));
});
it('keeps populated unknown or unreconciled work separate from an empty-account claim', () => {
  const p = adaptive();
  const view = render(<HomeScreen {...p} reconciled={false} />);
  expect(screen.getByRole('heading', { name: 'Check your workspace' })).toBeInTheDocument();
  expect(screen.queryByText('Create your first Proof')).not.toBeInTheDocument();
  view.rerender(<HomeScreen {...p} proofs={[{ ...summary, status: 'UNRECOGNIZED' }]} />);
  expect(screen.getByRole('button', { name: 'Refresh Proof' })).toBeInTheDocument();
});
