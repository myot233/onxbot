import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('messages').execute();
  await sql`delete from conversations`.execute(db);
  await db.schema
    .createTable('conversation_turns')
    .addColumn('id', 'bigint', (column) =>
      column.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn('conversation_id', 'uuid', (column) =>
      column.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('messages', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex('conversation_turns_order')
    .on('conversation_turns')
    .columns(['conversation_id', 'id'])
    .execute();
}
