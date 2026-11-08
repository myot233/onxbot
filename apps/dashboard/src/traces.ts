import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ModelTrace, TraceStore } from '@onxbot/model';

interface Recording {
  id: Promise<number | undefined> | undefined;
  session: string;
  count: number;
  truncated: boolean;
  writes: Promise<void>;
}

/** A trace failure must never replay a model request or a delivered QQ message. */
export class TraceRecorder {
  private readonly owner = randomUUID();
  private readonly current = new AsyncLocalStorage<Recording>();
  private readonly activeIds = new Set<number>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly store: TraceStore,
    private readonly onError: (error: unknown) => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.closed || this.timer) return;
    await this.store.maintain(this.owner, [...this.activeIds]);
    if (this.closed) return;
    this.timer = setInterval(() => {
      this.maintenance ??= this.store
        .maintain(this.owner, [...this.activeIds])
        .catch(this.onError)
        .finally(() => {
          this.maintenance = undefined;
        });
    }, 30_000);
    this.timer.unref();
  }

  run = <T>(session: string, work: () => Promise<T>): Promise<T> => {
    if (this.closed) return this.current.exit(work);
    const task = this.execute(session, work);
    this.inFlight.add(task);
    const done = () => this.inFlight.delete(task);
    void task.then(done, done);
    return task;
  };

  private async execute<T>(
    session: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const recording: Recording = {
      id: undefined,
      session,
      count: 0,
      truncated: false,
      writes: Promise.resolve(),
    };
    let status: '完成' | '失败' = '完成';
    try {
      return await this.current.run(recording, work);
    } catch (error) {
      status = '失败';
      throw error;
    } finally {
      await recording.writes;
      const id = await recording.id;
      if (id !== undefined) {
        try {
          await this.store
            .finish(id, status, recording.truncated)
            .catch(this.onError);
        } finally {
          this.activeIds.delete(id);
        }
      }
    }
  }

  record: ModelTrace = ({ phase, data }) => {
    const recording = this.current.getStore();
    if (!recording) return;
    if (recording.count >= 16) {
      recording.truncated = true;
      return;
    }
    let content: string;
    try {
      content =
        JSON.stringify(
          data,
          (key, value: unknown) =>
            key === 'providerOptions' || key === 'providerMetadata'
              ? undefined
              : value,
          2,
        ) ?? '';
    } catch {
      content = '此事件无法序列化。';
      recording.truncated = true;
    }
    if (content.length > 64_000) {
      recording.truncated = true;
      content = `${content.slice(0, 64_000)}\n… 已截断`;
    }
    recording.id ??= this.store
      .start(recording.session, this.owner)
      .then((id) => {
        this.activeIds.add(id);
        return id;
      })
      .catch((error) => {
        recording.truncated = true;
        this.onError(error);
        return undefined;
      });
    const sequence = recording.count++;
    recording.writes = recording.writes
      .then(async () => {
        const id = await recording.id;
        if (id !== undefined)
          await this.store.append(
            id,
            sequence,
            { phase, content },
            recording.truncated,
          );
      })
      .catch((error) => {
        recording.truncated = true;
        this.onError(error);
      });
  };

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
    clearInterval(this.timer);
    await this.maintenance;
  }
}
