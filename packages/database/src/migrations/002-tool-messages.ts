import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('tool_calls', 'jsonb')
    .addColumn('tool_call_id', 'text')
    .execute();
  await db.schema
    .alterTable('messages')
    .dropConstraint('messages_role')
    .execute();
  await db.schema
    .alterTable('messages')
    .addCheckConstraint(
      'messages_role',
      sql`role in ('user', 'assistant', 'tool')`,
    )
    .execute();
  await db.schema
    .alterTable('messages')
    .addCheckConstraint(
      'messages_tool_fields',
      sql`
      (role = 'user' and tool_calls is null and tool_call_id is null)
      or (role = 'assistant' and tool_call_id is null and (tool_calls is null or jsonb_typeof(tool_calls) = 'array'))
      or (role = 'tool' and tool_calls is null and tool_call_id is not null)
    `,
    )
    .execute();
}
