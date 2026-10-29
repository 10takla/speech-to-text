import { expect, it, vi } from 'vitest';
import { createOverlayRetention } from './overlay-retention';

it('keeps completed content until an outside click releases it', () => {
  const retention = createOverlayRetention();
  const hide = vi.fn();
  retention.onRelease(hide);
  retention.setPinned(true);
  expect(retention.complete()).toBe(false);
  expect(hide).not.toHaveBeenCalled();
  retention.setPinned(false);
  expect(hide).toHaveBeenCalledOnce();
});

it('an outside click during recording only removes the pin', () => {
  const retention = createOverlayRetention();
  const hide = vi.fn();
  retention.onRelease(hide);
  retention.setPinned(true);
  retention.setPinned(false);
  expect(hide).not.toHaveBeenCalled();
  expect(retention.complete()).toBe(true);
});

it('a new scenario prevents a stale completion from hiding its content', () => {
  const retention = createOverlayRetention();
  const hide = vi.fn();
  retention.onRelease(hide);
  retention.setPinned(true);
  retention.complete();
  retention.start();
  retention.setPinned(false);
  expect(hide).not.toHaveBeenCalled();
  expect(retention.complete()).toBe(true);
});

it('cancel clears the pin without waiting for an outside click', () => {
  const retention = createOverlayRetention();
  const hide = vi.fn();
  retention.onRelease(hide);
  retention.setPinned(true);
  retention.complete();
  retention.cancel();
  expect(retention.pinned).toBe(false);
  expect(hide).not.toHaveBeenCalled();
});

it('repeated clicks inside do not toggle the pin or clear a pending completion', () => {
  const retention = createOverlayRetention();
  const hide = vi.fn();
  retention.onRelease(hide);
  retention.setPinned(true);
  retention.complete();
  retention.setPinned(true);
  expect(retention.pinned).toBe(true);
  expect(hide).not.toHaveBeenCalled();
  retention.setPinned(false);
  retention.setPinned(false);
  expect(hide).toHaveBeenCalledOnce();
});
