import { randomInt } from 'node:crypto';
import {
  appendGroupLine,
  type GroupTopicStore,
  type ScheduledGroupTopic,
} from '@onxbot/core';
import { type Kysely, sql } from 'kysely';
import type { Database } from './schema.js';

const nextRun = () =>
  sql<Date>`now() + ${randomInt(900_000, 1_200_001)} * interval '1 millisecond'`;

export function createGroupTopicStore(db: Kysely<Database>): GroupTopicStore {
  return {
    async append(botId, groupId, line, human) {
      await db.transaction().execute(async (tx) => {
        if (human) {
          await tx
            .insertInto('group_topic_schedules')
            .values({
              bot_id: botId,
              group_id: groupId,
              next_run_at: nextRun(),
            })
            .onConflict((conflict) =>
              conflict.columns(['bot_id', 'group_id']).doNothing(),
            )
            .execute();
        }
        const row = await tx
          .selectFrom('group_topic_schedules')
          .select('context')
          .where('bot_id', '=', botId)
          .where('group_id', '=', groupId)
          .forUpdate()
          .executeTakeFirst();
        if (!row) return;
        appendGroupLine(row.context, line);
        await tx
          .updateTable('group_topic_schedules')
          .where('bot_id', '=', botId)
          .where('group_id', '=', groupId)
          .set({
            context: JSON.stringify(row.context),
            ...(human && {
              last_activity_at: sql<Date>`now()`,
              activity_version: sql<string>`activity_version + 1`,
            }),
          })
          .execute();
      });
    },
    async claimDue(botId, groupIds) {
      if (!groupIds.length) return [];
      return db.transaction().execute(async (tx) => {
        const rows = await tx
          .selectFrom('group_topic_schedules')
          .select(['group_id', 'activity_version', 'context'])
          .select(
            sql<boolean>`last_activity_at >= now() - interval '1 hour' and activity_version > consumed_version`.as(
              'fresh',
            ),
          )
          .where('bot_id', '=', botId)
          .where('group_id', 'in', groupIds)
          .where('next_run_at', '<=', sql<Date>`now()`)
          .forUpdate()
          .skipLocked()
          .execute();
        const due: ScheduledGroupTopic[] = [];
        for (const row of rows) {
          const eligible = row.fresh && row.context.length >= 2;
          await tx
            .updateTable('group_topic_schedules')
            .where('bot_id', '=', botId)
            .where('group_id', '=', row.group_id)
            .set({
              next_run_at: nextRun(),
              ...(eligible && { consumed_version: row.activity_version }),
            })
            .execute();
          if (eligible)
            due.push({
              groupId: row.group_id,
              activityVersion: row.activity_version,
              context: row.context,
            });
        }
        return due;
      });
    },
    async isCurrent(botId, topic) {
      const row = await db
        .selectFrom('group_topic_schedules')
        .select('group_id')
        .where('bot_id', '=', botId)
        .where('group_id', '=', topic.groupId)
        .where('activity_version', '=', topic.activityVersion)
        .executeTakeFirst();
      return Boolean(row);
    },
  };
}
