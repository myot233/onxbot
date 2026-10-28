import type { ConversationStore } from '@onxbot/core/conversation';
import type { ConversationMessage } from '@onxbot/model';
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
            const starts = await transaction
              .selectFrom('messages')
              .select('id')
              .where('conversation_id', '=', conversation.id)
              .where('role', '=', 'user')
              .orderBy('id', 'desc')
              .limit(limit)
              .execute();
            const start = starts.at(-1)?.id;
            if (!start) return [];
            const rows = await transaction
              .selectFrom('messages')
              .select(['role', 'content', 'tool_calls', 'tool_call_id'])
              .where('conversation_id', '=', conversation.id)
              .where('id', '>=', start)
              .orderBy('id')
              .execute();
            return rows.map((row): ConversationMessage => {
              if (row.role === 'tool') {
                if (!row.tool_call_id)
                  throw new Error('Stored tool result has no call ID.');
                return {
                  role: 'tool',
                  content: row.content,
                  toolCallId: row.tool_call_id,
                };
              }
              if (row.role === 'assistant' && row.tool_calls)
                return {
                  role: 'assistant',
                  content: row.content,
                  toolCalls: row.tool_calls,
                };
              return { role: row.role, content: row.content };
            });
          },
          async appendTurn(input, output) {
            await transaction
              .insertInto('messages')
              .values([
                {
                  conversation_id: conversation.id,
                  role: 'user',
                  content: input,
                  tool_calls: null,
                  tool_call_id: null,
                },
                ...output.map((message) => ({
                  conversation_id: conversation.id,
                  role: message.role,
                  content: message.content,
                  tool_calls:
                    message.role === 'assistant' && message.toolCalls
                      ? JSON.stringify(message.toolCalls)
                      : null,
                  tool_call_id:
                    message.role === 'tool' ? message.toolCallId : null,
                })),
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
