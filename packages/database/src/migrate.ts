import { type Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import * as conversations from './migrations/001-conversations.js';
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
        return { '001-conversations': conversations };
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}
