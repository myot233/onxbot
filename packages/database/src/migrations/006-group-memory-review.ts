import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('group_memory_schedules')
    .addColumn('bot_id', 'text', (c) => c.notNull())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('next_run_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now() + interval '1 hour'`),
    )
    .addColumn('lease', 'text')
    .addColumn('lease_until', 'timestamptz')
    .addPrimaryKeyConstraint('group_memory_schedule_identity', [
      'bot_id',
      'group_id',
    ])
    .execute();
  await db.schema
    .createTable('group_memory_messages')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('bot_id', 'text', (c) => c.notNull())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('line', 'jsonb', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('group_memory_messages_batch')
    .on('group_memory_messages')
    .columns(['bot_id', 'group_id', 'id'])
    .execute();
}
