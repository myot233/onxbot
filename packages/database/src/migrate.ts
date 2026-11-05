import { type Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import * as conversations from './migrations/001-conversations.js';
import * as toolMessages from './migrations/002-tool-messages.js';
import * as sdkTurns from './migrations/003-sdk-turns.js';
import * as groupFeedback from './migrations/004-group-feedback.js';
import * as groupTopicSchedules from './migrations/005-group-topic-schedules.js';
import type { Database } from './schema.js';

export async function migrate(db: Kysely<Database>): Promise<void> {
  const { rows } = await sql<{
    schema: string;
  }>`select current_schema() as schema`.execute(db);
  const schema = rows[0]?.schema;
  if (!schema)
    throw new Error(
      'PostgreSQL search_path does not contain a writable schema.',
    );
  const migrator = new Migrator({
    db,
    migrationTableSchema: schema,
    provider: {
      async getMigrations() {
        return {
          '001-conversations': conversations,
          '002-tool-messages': toolMessages,
          '003-sdk-turns': sdkTurns,
          '004-group-feedback': groupFeedback,
          '005-group-topic-schedules': groupTopicSchedules,
        };
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}
