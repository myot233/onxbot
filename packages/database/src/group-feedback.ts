import { createHmac } from 'node:crypto';
import type { GroupFeedback } from '@onxbot/core';
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export function createGroupFeedback(
  db: Kysely<Database>,
  policy: string,
  voterKey: string,
): GroupFeedback {
  return {
    async record(sample) {
      const speakers = new Map<string, number>();
      const context = sample.context.map((line) => {
        const speaker = speakers.get(line.speaker) ?? speakers.size + 1;
        speakers.set(line.speaker, speaker);
        return { ...line, speaker };
      });
      await db
        .insertInto('group_decisions')
        .values({
          group_id: sample.groupId,
          message_id: sample.messageId,
          reply_id: sample.replyId ?? null,
          policy,
          trigger: sample.trigger,
          outcome: sample.outcome,
          context: JSON.stringify(context),
          reply: sample.reply ?? null,
        })
        .onConflict((conflict) =>
          conflict.columns(['group_id', 'message_id']).doNothing(),
        )
        .execute();
    },
    async rate(groupId, replyId, voterId, label) {
      const decision = await db
        .selectFrom('group_decisions')
        .select('id')
        .where('group_id', '=', groupId)
        .where('reply_id', '=', replyId)
        .executeTakeFirst();
      if (!decision) return false;
      const voter = createHmac('sha256', voterKey)
        .update(JSON.stringify([groupId, voterId]))
        .digest('hex');
      await db
        .insertInto('group_ratings')
        .values({ decision_id: decision.id, voter_id: voter, label })
        .onConflict((conflict) =>
          conflict.columns(['decision_id', 'voter_id']).doUpdateSet({ label }),
        )
        .execute();
      return true;
    },
  };
}
