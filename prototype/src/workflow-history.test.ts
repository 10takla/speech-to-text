import { describe, expect, it, vi } from 'vitest';
import type { HistoryRepository } from './ports';
import { createWorkflowHistory } from './workflow-history';

describe('workflow history queue', () => {
  it('keeps later results after a rejected status write and waits for the final save', async () => {
    let release!: () => void;
    const finalSave = new Promise<void>(resolve => { release = resolve; });
    const update = vi.fn<HistoryRepository['update']>()
      .mockRejectedValueOnce(new Error('Storage temporarily unavailable'))
      .mockImplementationOnce(async () => { await finalSave; return null; });
    const queue = createWorkflowHistory({ update }, 'entry');
    const first = queue.update({ status: 'transcribed' });
    const last = queue.update({ status: 'success' });
    await expect(first).rejects.toThrow('Storage temporarily unavailable');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    let flushed = false;
    const flushing = queue.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await last;
    await flushing;
    expect(update.mock.calls).toEqual([
      ['entry', { status: 'transcribed' }], ['entry', { status: 'success' }],
    ]);
  });
});
