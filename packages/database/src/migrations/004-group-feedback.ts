import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('group_decisions')
    .addColumn('id', 'bigint', (column) =>
      column.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn('group_id', 'text', (column) => column.notNull())
    .addColumn('message_id', 'text', (column) => column.notNull())
    .addColumn('reply_id', 'text')
    .addColumn('policy', 'text', (column) => column.notNull())
    .addColumn('trigger', 'text', (column) => column.notNull())
    .addColumn('outcome', 'text', (column) => column.notNull())
    .addColumn('context', 'jsonb', (column) => column.notNull())
    .addColumn('reply', 'text')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('group_decision_message', ['group_id', 'message_id'])
    .addUniqueConstraint('group_decision_reply', ['group_id', 'reply_id'])
    .execute();
  await db.schema
    .createTable('group_ratings')
    .addColumn('decision_id', 'bigint', (column) =>
      column.references('group_decisions.id').onDelete('cascade'),
    )
    .addColumn('voter_id', 'text')
    .addColumn('label', 'text', (column) => column.notNull())
    .addPrimaryKeyConstraint('group_rating_voter', ['decision_id', 'voter_id'])
    .execute();
}
