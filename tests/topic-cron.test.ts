import { expect, it, vi } from 'vitest';
import { startTopicCron } from '../packages/koishi-plugin-chat/src/topic-cron.js';

it('checks every five seconds without overlap and drains active work on stop', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-02T02:00:00Z'));
  const blocked = Promise.withResolvers<void>();
  const poll = vi.fn(() => blocked.promise);
  const errors = vi.fn();
  const stop = startTopicCron(poll, errors);
  try {
    await vi.advanceTimersByTimeAsync(4_999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(poll).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    blocked.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(poll).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    blocked.resolve();
    await stop();
    vi.useRealTimers();
  }
});

it('reports a failed check and permits the next scheduled check', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-02T02:00:00Z'));
  const failure = new Error('Database unavailable');
  const poll = vi.fn(async () => {}).mockRejectedValueOnce(failure);
  const errors = vi.fn();
  const stop = startTopicCron(poll, errors);
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(errors).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledOnce();
    await stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
  } finally {
    await stop();
    vi.useRealTimers();
  }
});
