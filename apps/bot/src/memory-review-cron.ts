import type { GroupMemoryReviewStore, MemoryReview } from '@onxbot/core';
import { Cron } from 'croner';

export function startMemoryReviewCron(options: {
  botId: string;
  groupIds: readonly string[];
  store: GroupMemoryReviewStore;
  review: Pick<MemoryReview, 'run'>;
  observe?: (session: string, work: () => Promise<void>) => Promise<void>;
}) {
  let running = Promise.resolve();
  const job = new Cron(
    '*/5 * * * *',
    {
      timezone: 'Asia/Shanghai',
      protect: true,
      unref: true,
    },
    () => {
      running = (async () => {
        const batch = await options.store.claimDue(
          options.botId,
          options.groupIds,
        );
        if (!batch) return;
        const run = () => options.review.run(batch);
        if (options.observe)
          await options.observe(
            `onebot/${options.botId}/memory-review/${batch.groupId}`,
            run,
          );
        else await run();
      })().catch((error: unknown) =>
        console.warn('Scheduled memory review failed:', error),
      );
      return running;
    },
  );
  return async () => {
    job.stop();
    await running;
  };
}
