import type { ConversationStore } from '@onxbot/core/conversation';
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
          async getRecentTurns(limit) {
            if (limit === 0) return [];
            const rows = await transaction
              .selectFrom('conversation_turns')
              .select('messages')
              .where('conversation_id', '=', conversation.id)
              .orderBy('id', 'desc')
              .limit(limit)
              .execute();
            return rows.reverse().flatMap((row) => row.messages);
          },
          async appendTurn(input, output) {
            await transaction
              .insertInto('conversation_turns')
              .values({
                conversation_id: conversation.id,
                messages: JSON.stringify([
                  { role: 'user', content: input },
                  ...output,
                ]),
              })
              .execute();
          },
          async clear() {
            await transaction
              .deleteFrom('conversation_turns')
              .where('conversation_id', '=', conversation.id)
              .execute();
          },
        });
      });
    },
  };
}
