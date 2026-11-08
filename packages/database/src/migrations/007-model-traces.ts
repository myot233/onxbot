import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('model_traces')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('session', 'text', (c) => c.notNull())
    .addColumn('owner_id', 'text', (c) => c.notNull())
    .addColumn('lease_until', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now() + interval '90 seconds'`),
    )
    .addColumn('started_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('finished_at', 'timestamptz')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('运行中'))
    .addColumn('truncated', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('event_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addCheckConstraint(
      'model_trace_status',
      sql`status in ('运行中', '完成', '失败', '中断')`,
    )
    .execute();
  await db.schema
    .createIndex('model_traces_session_id')
    .on('model_traces')
    .columns(['session', 'id'])
    .execute();
  await db.schema
    .createIndex('model_traces_running_lease')
    .on('model_traces')
    .column('lease_until')
    .where(sql<boolean>`status = '运行中'`)
    .execute();
  await db.schema
    .createTable('model_trace_events')
    .addColumn('trace_id', 'integer', (c) =>
      c.notNull().references('model_traces.id').onDelete('cascade'),
    )
    .addColumn('sequence', 'integer', (c) => c.notNull())
    .addColumn('phase', 'text', (c) => c.notNull())
    .addColumn('content', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('model_trace_event_identity', [
      'trace_id',
      'sequence',
    ])
    .addCheckConstraint('model_trace_phase', sql`phase in ('input', 'output')`)
    .execute();
}
