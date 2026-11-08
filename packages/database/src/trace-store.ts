import type { TraceStore } from '@onxbot/model';
import { type Kysely, sql } from 'kysely';
import type { Database } from './schema.js';

const columns = [
  'id',
  'session',
  'started_at as startedAt',
  'finished_at as finishedAt',
  'status',
  'truncated',
  'event_count as eventCount',
] as const;
const dates = <T extends { startedAt: Date; finishedAt: Date | null }>(
  row: T,
) => {
  const { startedAt, finishedAt, ...rest } = row;
  return {
    ...rest,
    startedAt: startedAt.toISOString(),
    ...(finishedAt && { finishedAt: finishedAt.toISOString() }),
  };
};

export function createTraceStore(db: Kysely<Database>): TraceStore {
  return {
    async start(session, owner) {
      return (
        await db
          .insertInto('model_traces')
          .values({ session, owner_id: owner })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    },
    async append(id, sequence, event, truncated) {
      await db.transaction().execute(async (tx) => {
        const inserted = await tx
          .insertInto('model_trace_events')
          .values({ trace_id: id, sequence, ...event })
          .onConflict((c) => c.columns(['trace_id', 'sequence']).doNothing())
          .returning('sequence')
          .executeTakeFirst();
        if (inserted)
          await tx
            .updateTable('model_traces')
            .set({
              event_count: sql`event_count + 1`,
              truncated: sql`truncated or ${truncated}`,
            })
            .where('id', '=', id)
            .execute();
      });
    },
    async finish(id, status, truncated) {
      await db
        .updateTable('model_traces')
        .set({
          status,
          finished_at: sql`now()`,
          truncated: sql`truncated or ${truncated}`,
        })
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    },
    async list(query) {
      let select = db.selectFrom('model_traces').select(columns);
      if (query.session) select = select.where('session', '=', query.session);
      if (query.status) select = select.where('status', '=', query.status);
      if (query.before) select = select.where('id', '<', query.before);
      if (query.search)
        select = select.where((eb) =>
          eb.or([
            eb(
              sql<number>`position(lower(${query.search}) in lower(session))`,
              '>',
              0,
            ),
            eb(sql<number>`position(${query.search} in id::text)`, '>', 0),
          ]),
        );
      const rows = await select
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const traces = rows.slice(0, query.limit).map(dates);
      const nextCursor =
        rows.length > query.limit ? traces.at(-1)?.id : undefined;
      return {
        traces,
        limit: query.limit,
        ...(nextCursor !== undefined && { nextCursor }),
      };
    },
    async get(id) {
      return db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (tx) => {
          const row = await tx
            .selectFrom('model_traces')
            .select(columns)
            .where('id', '=', id)
            .executeTakeFirst();
          if (!row) return undefined;
          const events = await tx
            .selectFrom('model_trace_events')
            .select(['phase', 'content'])
            .where('trace_id', '=', id)
            .orderBy('sequence', 'asc')
            .execute();
          const { eventCount: _, ...trace } = dates(row);
          return { ...trace, events };
        });
    },
    async maintain(owner, activeIds) {
      if (activeIds.length)
        await db
          .updateTable('model_traces')
          .set({ lease_until: sql`now() + interval '90 seconds'` })
          .where('owner_id', '=', owner)
          .where('id', 'in', activeIds)
          .where('status', '=', '运行中')
          .execute();
      await db
        .updateTable('model_traces')
        .set({ status: '中断' })
        .where('status', '=', '运行中')
        .where('lease_until', '<', sql<Date>`now()`)
        .execute();
    },
  };
}
