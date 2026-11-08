import type { Trace, TraceStore } from '../../packages/model/src/index.js';

export function memoryTraceStore(): TraceStore {
  const rows = new Map<number, Trace>();
  let nextId = 0;
  return {
    async start(session) {
      const id = ++nextId;
      rows.set(id, {
        id,
        session,
        startedAt: new Date().toISOString(),
        status: '运行中',
        truncated: false,
        events: [],
      });
      return id;
    },
    async append(id, sequence, event, truncated) {
      const row = rows.get(id);
      if (!row) throw new Error('Missing trace');
      row.events[sequence] = event;
      row.truncated ||= truncated;
    },
    async finish(id, status, truncated) {
      const row = rows.get(id);
      if (!row) throw new Error('Missing trace');
      Object.assign(row, {
        status,
        finishedAt: new Date().toISOString(),
        truncated: row.truncated || truncated,
      });
    },
    async list(query) {
      const traces = [...rows.values()]
        .reverse()
        .filter(
          (t) =>
            (!query.session || t.session === query.session) &&
            (!query.status || t.status === query.status) &&
            (!query.before || t.id < query.before) &&
            (!query.search || `${t.id} ${t.session}`.includes(query.search)),
        )
        .map(({ events, ...t }) => ({ ...t, eventCount: events.length }));
      const page = traces.slice(0, query.limit);
      const cursor = traces.length > query.limit ? page.at(-1)?.id : undefined;
      return {
        traces: page,
        limit: query.limit,
        ...(cursor !== undefined && { nextCursor: cursor }),
      };
    },
    async get(id) {
      return rows.get(id);
    },
    async maintain() {},
  };
}
