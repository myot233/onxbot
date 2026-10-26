import { createDatabase, migrate } from '@onxbot/database';
import { z } from 'zod';

async function main(): Promise<void> {
  const connection = z
    .url({ protocol: /^postgres(ql)?$/ })
    .safeParse(process.env.DATABASE_URL);
  if (!connection.success)
    throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  const db = createDatabase(connection.data);
  try {
    await migrate(db);
    console.info('Database migrations applied.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    'Migration failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
