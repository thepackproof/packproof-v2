import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfigurationApproval } from '../records/ConfigurationApproval';

const digest = 'a'.repeat(64);
const observedAt = '2026-11-17T18:00:00Z';
const current = { schema: 'packproof.scheduled-csv/v2', historyPolicy: { observedAt } };

afterEach(() => { cleanup(); vi.useRealTimers(); });

test('a review expires on screen immediately after the server deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T18:29:59Z'));
  const onApprove = vi.fn();
  render(<ConfigurationApproval proposalSha256={digest} sourceContract={current} busy={false} onApprove={onApprove}/>);
  const button = screen.getByRole('button', { name: 'Approve configuration' });
  fireEvent.click(screen.getByRole('checkbox'));
  act(() => { vi.advanceTimersByTime(1000); });
  expect(button).toBeEnabled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(button).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent(/expired after 30 minutes.*reopen the selected local report/i);
  fireEvent.click(button);
  expect(onApprove).not.toHaveBeenCalled();
});

test('rechecks the deadline at the click even when a background timer has not run', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(observedAt));
  const onApprove = vi.fn();
  render(<ConfigurationApproval proposalSha256={digest} sourceContract={current} busy={false} onApprove={onApprove}/>);
  fireEvent.click(screen.getByRole('checkbox'));
  vi.setSystemTime(new Date('2026-11-17T19:00:00Z'));
  fireEvent.click(screen.getByRole('button'));
  expect(onApprove).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent(/expired/i);
});

test.each([
  { proposalSha256: digest, sourceContract: { schema: current.schema } },
  { proposalSha256: digest, sourceContract: { schema: current.schema, historyPolicy: { observedAt: 'bad' } } },
  { proposalSha256: null, sourceContract: { schema: 'packproof.scheduled-csv/v1' } },
  { proposalSha256: 'bad', sourceContract: { schema: 'packproof.scheduled-csv/v1' } },
])('an incomplete review cannot submit and explains how to replace it', props => {
  render(<ConfigurationApproval {...props} busy={false} onApprove={vi.fn()}/>);
  expect(screen.getByRole('button')).toBeDisabled();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent(/incomplete.*request a fresh review/i);
});

test('legacy approval keeps consent while retrying the same proposal and clears it for a replacement', () => {
  const onApprove = vi.fn();
  const props = { proposalSha256: digest, sourceContract: { schema: 'packproof.scheduled-csv/v1' }, busy: false, onApprove };
  const { rerender } = render(<ConfigurationApproval {...props}/>);
  const button = screen.getByRole('button');
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  expect(onApprove).toHaveBeenCalledTimes(1);
  rerender(<ConfigurationApproval {...props} busy/>);
  expect(button).toHaveTextContent('Saving approval');
  expect(button).toBeDisabled();
  rerender(<ConfigurationApproval {...props} error="Service unavailable. Try again."/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(button).toBeEnabled();
  rerender(<ConfigurationApproval {...props} proposalSha256={'b'.repeat(64)}/>);
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(button).toBeDisabled();
});
