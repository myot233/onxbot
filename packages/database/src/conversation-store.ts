import type { ConversationStore } from '@onxbot/core';
import { type Kysely, sql } from 'kysely';
import type { Database } from './schema.js';

export function createConversationStore(
  db: Kysely<Database>,
): ConversationStore {
  return {
    async withConversation(identity, work) {
      return db.transaction().execute(async (transaction) => {
        // The upsert locks this identity until commit, even when two first turns race.
        const conversation = await transaction
          .insertInto('conversations')
          .values({
            platform: identity.platform,
            bot_id: identity.botId,
            channel_id: identity.channelId,
            user_id: identity.userId,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['platform', 'bot_id', 'channel_id', 'user_id'])
              .doUpdateSet({ updated_at: sql`now()` }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        return work({
          async getMessages(limit) {
            const rows = await transaction
              .selectFrom('messages')
              .select(['role', 'content'])
              .where('conversation_id', '=', conversation.id)
              .orderBy('id', 'desc')
              .limit(limit)
              .execute();
            return rows.reverse();
          },
          async appendTurn(input, reply) {
            await transaction
              .insertInto('messages')
              .values([
                {
                  conversation_id: conversation.id,
                  role: 'user',
                  content: input,
                },
                {
                  conversation_id: conversation.id,
                  role: 'assistant',
                  content: reply,
                },
              ])
              .execute();
          },
          async clear() {
            await transaction
              .deleteFrom('messages')
              .where('conversation_id', '=', conversation.id)
              .execute();
          },
        });
      });
    },
  };
}
