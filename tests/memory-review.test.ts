import { expect, it, vi } from 'vitest';
import { startMemoryReviewCron } from '../apps/bot/src/memory-review-cron.js';
import type { GroupMemoryBatch } from '../packages/core/src/index.js';

it('prevents cron overlap and drains an active review when stopped', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T02:00:00Z'));
  const batch: GroupMemoryBatch = {
    botId: '100',
    groupId: '42',
    lease: 'lease',
    throughId: '1',
    lines: [],
  };
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async () => blocked);
  const claimDue = vi.fn(async () => batch);
  const observe = vi.fn(async (_session: string, work: () => Promise<void>) =>
    work(),
  );
  const stop = startMemoryReviewCron({
    botId: '100',
    groupIds: ['42'],
    store: { append: vi.fn(), claimDue, renewLease: vi.fn(), finish: vi.fn() },
    review: { run },
    observe,
  });
  try {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimDue).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]?.[0]).toBe('onebot/100/memory-review/42');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(claimDue).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(claimDue).toHaveBeenCalledOnce();
  } finally {
    release();
    await stop();
    vi.useRealTimers();
  }
});
