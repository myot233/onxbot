import { randomUUID } from 'node:crypto';
import type { GroupMemoryReviewStore } from '@onxbot/core';
import { type Kysely, sql } from 'kysely';
import type { Database } from './schema.js';

export function createGroupMemoryReviewStore(
  db: Kysely<Database>,
): GroupMemoryReviewStore {
  return {
    async append(botId, groupId, line) {
      await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('group_memory_schedules')
          .values({ bot_id: botId, group_id: groupId })
          .onConflict((c) => c.columns(['bot_id', 'group_id']).doNothing())
          .execute();
        // Serialize insertion with claims so an earlier sequence ID cannot commit late.
        await tx
          .selectFrom('group_memory_schedules')
          .select('group_id')
          .where('bot_id', '=', botId)
          .where('group_id', '=', groupId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('group_memory_messages')
          .values({
            bot_id: botId,
            group_id: groupId,
            line: JSON.stringify(line),
          })
          .execute();
      });
    },
    async claimDue(botId, groupIds) {
      if (!groupIds.length) return;
      return db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom('group_memory_schedules')
          .select('group_id')
          .where('bot_id', '=', botId)
          .where('group_id', 'in', groupIds)
          .where('next_run_at', '<=', sql<Date>`now()`)
          .where((eb) =>
            eb.or([
              eb('lease_until', 'is', null),
              eb('lease_until', '<=', sql<Date>`now()`),
            ]),
          )
          .orderBy('next_run_at')
          .forUpdate()
          .skipLocked()
          .limit(1)
          .executeTakeFirst();
        if (!row) return;
        const messages = await tx
          .selectFrom('group_memory_messages')
          .select(['id', 'line'])
          .where('bot_id', '=', botId)
          .where('group_id', '=', row.group_id)
          .orderBy('id')
          .limit(100)
          .execute();
        const last = messages.at(-1);
        if (!last) {
          await tx
            .updateTable('group_memory_schedules')
            .set({
              next_run_at: sql<Date>`now() + interval '1 hour'`,
              lease: null,
              lease_until: null,
            })
            .where('bot_id', '=', botId)
            .where('group_id', '=', row.group_id)
            .execute();
          return;
        }
        const lease = randomUUID();
        await tx
          .updateTable('group_memory_schedules')
          .set({ lease, lease_until: sql<Date>`now() + interval '10 minutes'` })
          .where('bot_id', '=', botId)
          .where('group_id', '=', row.group_id)
          .execute();
        return {
          botId,
          groupId: row.group_id,
          lease,
          throughId: last.id,
          lines: messages.map((m) => m.line),
        };
      });
    },
    async renewLease(batch) {
      const row = await db
        .updateTable('group_memory_schedules')
        .set({ lease_until: sql<Date>`now() + interval '10 minutes'` })
        .where('bot_id', '=', batch.botId)
        .where('group_id', '=', batch.groupId)
        .where('lease', '=', batch.lease)
        .where('lease_until', '>', sql<Date>`now()`)
        .returning('group_id')
        .executeTakeFirst();
      return Boolean(row);
    },
    async finish(batch, success) {
      await db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom('group_memory_schedules')
          .select('group_id')
          .where('bot_id', '=', batch.botId)
          .where('group_id', '=', batch.groupId)
          .where('lease', '=', batch.lease)
          .where('lease_until', '>', sql<Date>`now()`)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new Error('Memory review lease expired.');
        if (success)
          await tx
            .deleteFrom('group_memory_messages')
            .where('bot_id', '=', batch.botId)
            .where('group_id', '=', batch.groupId)
            .where('id', '<=', batch.throughId)
            .execute();
        const remaining = await tx
          .selectFrom('group_memory_messages')
          .select('id')
          .where('bot_id', '=', batch.botId)
          .where('group_id', '=', batch.groupId)
          .limit(1)
          .executeTakeFirst();
        await tx
          .updateTable('group_memory_schedules')
          .set({
            lease: null,
            lease_until: null,
            next_run_at: !success
              ? sql<Date>`now() + interval '5 minutes'`
              : remaining
                ? sql<Date>`now()`
                : sql<Date>`now() + interval '1 hour'`,
          })
          .where('bot_id', '=', batch.botId)
          .where('group_id', '=', batch.groupId)
          .execute();
      });
    },
  };
}
