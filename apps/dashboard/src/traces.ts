import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelTrace } from '@onxbot/model';
import type { Trace } from './contract.js';

export class TraceBuffer {
  readonly startedAt = new Date().toISOString();
  private readonly current = new AsyncLocalStorage<Trace>();
  private readonly recent: Trace[] = [];
  private nextId = 0;

  run = async <T>(session: string, work: () => Promise<T>): Promise<T> => {
    const trace: Trace = {
      id: ++this.nextId,
      session,
      startedAt: new Date().toISOString(),
      status: '运行中',
      events: [],
      truncated: false,
    };
    try {
      const result = await this.current.run(trace, work);
      trace.status = '完成';
      trace.finishedAt = new Date().toISOString();
      return result;
    } catch (error) {
      trace.status = '失败';
      trace.finishedAt = new Date().toISOString();
      throw error;
    }
  };

  record: ModelTrace = ({ phase, data }) => {
    const trace = this.current.getStore();
    if (!trace) return;
    if (trace.events.length >= 16) {
      trace.truncated = true;
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
    }
    if (content.length > 64_000) {
      trace.truncated = true;
      content = `${content.slice(0, 64_000)}\n… 已截断`;
    }
    if (!trace.events.length) {
      this.recent.unshift(trace);
      if (this.recent.length > 50) this.recent.pop();
    }
    trace.events.push({ phase, content });
  };

  get(id: number): Trace | undefined {
    return this.recent.find((trace) => trace.id === id);
  }

  list(): readonly Trace[] {
    return this.recent;
  }
}
