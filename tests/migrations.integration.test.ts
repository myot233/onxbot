import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createConversationStore,
  migrate,
} from '../packages/database/src/index.js';
import { createTestDatabase } from './helpers/database.js';

it('starts SDK conversation history empty when migrating a legacy database', async () => {
  const fixture = await createTestDatabase({ legacy: true });
  try {
    const identity = {
      platform: 'onebot',
      botId: '1',
      channelId: '2',
      userId: '3',
    };
    const row = await fixture.db
      .insertInto('conversations')
      .values({
        platform: identity.platform,
        bot_id: identity.botId,
        channel_id: identity.channelId,
        user_id: identity.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`insert into messages (conversation_id, role, content) values
      (${row.id}, 'user', 'before upgrade'), (${row.id}, 'assistant', 'old reply')`.execute(
      fixture.db,
    );
    await migrate(fixture.db);
    await migrate(fixture.db);
    const history = await createConversationStore(fixture.db).withConversation(
      identity,
      (session) => session.getRecentTurns(1),
    );
    expect(history).toEqual([]);
    await expect(
      sql`select * from messages`.execute(fixture.db),
    ).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});
