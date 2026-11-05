import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('group_topic_schedules')
    .addColumn('bot_id', 'text', (column) => column.notNull())
    .addColumn('group_id', 'text', (column) => column.notNull())
    .addColumn('next_run_at', 'timestamptz', (column) => column.notNull())
    .addColumn('last_activity_at', 'timestamptz')
    .addColumn('activity_version', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('consumed_version', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('context', 'jsonb', (column) =>
      column.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addPrimaryKeyConstraint('group_topic_schedule_identity', [
      'bot_id',
      'group_id',
    ])
    .execute();
}
