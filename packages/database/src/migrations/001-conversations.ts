import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('conversations')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(sql`uuidv7()`),
    )
    .addColumn('platform', 'text', (column) => column.notNull())
    .addColumn('bot_id', 'text', (column) => column.notNull())
    .addColumn('channel_id', 'text', (column) => column.notNull())
    .addColumn('user_id', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('conversation_identity', [
      'platform',
      'bot_id',
      'channel_id',
      'user_id',
    ])
    .execute();

  await db.schema
    .createTable('messages')
    .addColumn('id', 'bigint', (column) =>
      column.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn('conversation_id', 'uuid', (column) =>
      column.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('role', 'text', (column) => column.notNull())
    .addColumn('content', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint('messages_role', sql`role in ('user', 'assistant')`)
    .execute();

  await db.schema
    .createIndex('messages_conversation_order')
    .on('messages')
    .columns(['conversation_id', 'id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('messages').execute();
  await db.schema.dropTable('conversations').execute();
}
