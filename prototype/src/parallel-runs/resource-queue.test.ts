import { expect, it, vi } from 'vitest';
import { createResourceQueue } from './resource-queue';

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it('waits for all reserved outputs of an earlier run, including inputs that are not ready', async () => {
  const queue = createResourceQueue();
  queue.register('first', ['copy', 'paste']);
  queue.register('second', ['copy']);
  const calls: string[] = [];
  const second = queue.execute('second', 'copy', async () => { calls.push('second'); });
  await queue.execute('first', 'copy', async () => { calls.push('first-copy'); });
  await tick();
  expect(calls).toEqual(['first-copy']);
  await queue.execute('first', 'paste', async () => { calls.push('first-paste'); });
  await second;
  expect(calls).toEqual(['first-copy', 'first-paste', 'second']);
});

it('orders ready actions by step position and skips runs without actions', async () => {
  const queue = createResourceQueue();
  queue.setPaused(true);
  queue.register('empty', []);
  queue.register('run', ['a', 'b', 'c']);
  const calls: string[] = [];
  const c = queue.execute('run', 'c', async () => { calls.push('c'); });
  const a = queue.execute('run', 'a', async () => { calls.push('a'); });
  queue.setPaused(false);
  await Promise.all([a, c]);
  expect(calls).toEqual(['a', 'c']);
  queue.skip('run', ['b']);
});

it('releases failed branches and cancelled waiters without overlapping an active action', async () => {
  const queue = createResourceQueue();
  queue.register('first', ['playing', 'unreachable']);
  queue.register('cancelled', ['copy']);
  queue.register('last', ['copy']);
  let release!: () => void;
  const running = queue.execute('first', 'playing', () => new Promise<void>(resolve => { release = resolve; }));
  const removed = queue.execute('cancelled', 'copy', async () => {});
  const rejected = expect(removed).rejects.toMatchObject({ name: 'AbortError' });
  const last = vi.fn(async () => {});
  const finished = queue.execute('last', 'copy', last);
  queue.finish('cancelled');
  queue.skip('first', ['unreachable']);
  queue.finish('first');
  await rejected;
  expect(last).not.toHaveBeenCalled();
  release();
  await Promise.all([running, finished]);
  expect(last).toHaveBeenCalledOnce();
});

it('keeps independent resources independent and continues after an output failure', async () => {
  const text = createResourceQueue(), speech = createResourceQueue();
  text.register('a', ['copy']); text.register('b', ['copy']);
  speech.register('a', ['speak']); speech.setPaused(true);
  const playback = vi.fn(async () => {});
  const playing = speech.execute('a', 'speak', playback);
  await expect(text.execute('a', 'copy', async () => { throw new Error('copy failed'); })).rejects.toThrow('copy failed');
  await expect(text.execute('b', 'copy', async () => 'done')).resolves.toBe('done');
  expect(playback).not.toHaveBeenCalled();
  speech.setPaused(false); await playing;
});

it('lets the next run paste before an earlier run copies, keeping copies in order', async () => {
  const queue = createResourceQueue();
  queue.register('first', ['paste-1', 'copy-1'], ['paste-1']);
  queue.register('second', ['paste-2', 'copy-2'], ['paste-2']);
  const calls: string[] = [];
  await queue.execute('first', 'paste-1', async () => { calls.push('paste-1'); });
  // The second run is still recording: the first run's copy waits for its paste.
  const copy1 = queue.execute('first', 'copy-1', async () => { calls.push('copy-1'); });
  await tick();
  expect(calls).toEqual(['paste-1']);
  const copy2 = queue.execute('second', 'copy-2', async () => { calls.push('copy-2'); });
  await queue.execute('second', 'paste-2', async () => { calls.push('paste-2'); });
  await Promise.all([copy1, copy2]);
  expect(calls).toEqual(['paste-1', 'paste-2', 'copy-1', 'copy-2']);
});

it('does not hold a copy for a run whose copy comes before its paste', async () => {
  const queue = createResourceQueue();
  queue.register('first', ['copy-1'], []);
  queue.register('second', ['copy-2', 'paste-2'], ['paste-2']);
  queue.register('third', ['paste-3'], ['paste-3']);
  const calls: string[] = [];
  await queue.execute('first', 'copy-1', async () => { calls.push('copy-1'); });
  await queue.execute('second', 'copy-2', async () => { calls.push('copy-2'); });
  await queue.execute('second', 'paste-2', async () => { calls.push('paste-2'); });
  await queue.execute('third', 'paste-3', async () => { calls.push('paste-3'); });
  expect(calls).toEqual(['copy-1', 'copy-2', 'paste-2', 'paste-3']);
});

it('releases a held copy when the later run is cancelled', async () => {
  const queue = createResourceQueue();
  queue.register('first', ['copy-1'], []);
  queue.register('second', ['paste-2'], ['paste-2']);
  const copy = vi.fn(async () => {});
  const held = queue.execute('first', 'copy-1', copy);
  await tick();
  expect(copy).not.toHaveBeenCalled();
  queue.finish('second');
  await held;
  expect(copy).toHaveBeenCalledOnce();
});
