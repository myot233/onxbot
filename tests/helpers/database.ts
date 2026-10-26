import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase, migrate } from '../../packages/database/src/index.js';

export async function createTestDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      'Integration tests require TEST_DATABASE_URL. See README.md.',
    );
  const admin = new Pool({ connectionString });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(connectionString);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(scoped.toString());
  try {
    await migrate(db);
  } catch (error) {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
    throw error;
  }
  return {
    db,
    connectionString: scoped.toString(),
    async close() {
      await db.destroy();
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
    },
  };
}
