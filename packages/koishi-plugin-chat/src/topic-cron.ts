import { Cron } from 'croner';

/** Wake the durable topic worker without overlapping or abandoning a run. */
export function startTopicCron(
  poll: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let running = Promise.resolve();
  const job = new Cron(
    '*/5 * * * * *',
    { timezone: 'Asia/Shanghai', protect: true, unref: true },
    () => {
      running = Promise.resolve().then(poll).catch(onError);
      return running;
    },
  );
  return async () => {
    job.stop();
    await running;
  };
}
