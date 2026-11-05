import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createDatabase,
  createGroupTopicStore,
} from '../packages/database/src/index.js';
import { createTestDatabase } from './helpers/database.js';

it('retains topic schedules and context across connections and claims each slot once', async () => {
  const fixture = await createTestDatabase();
  const reopened = createDatabase(fixture.connectionString);
  const writer = createGroupTopicStore(fixture.db);
  const worker = createGroupTopicStore(reopened);
  const first = { speaker: 'A', text: '周二有空' };
  const second = { speaker: 'B', text: '想找家咖啡馆' };
  const dueNow = () =>
    fixture.db
      .updateTable('group_topic_schedules')
      .set({ next_run_at: sql<Date>`now() - interval '1 second'` })
      .where('bot_id', '=', '100')
      .where('group_id', '=', '42')
      .execute();
  const schedule = () =>
    fixture.db
      .selectFrom('group_topic_schedules')
      .selectAll()
      .where('bot_id', '=', '100')
      .where('group_id', '=', '42')
      .executeTakeFirstOrThrow();
  try {
    await writer.append('100', '42', first, true);
    const initial = await schedule();
    await writer.append('100', '42', second, true);
    expect((await schedule()).next_run_at).toEqual(initial.next_run_at);
    expect(await worker.claimDue('100', ['42'])).toEqual([]);

    await dueNow();
    expect(await worker.claimDue('999', ['42'])).toEqual([]);
    const results = await Promise.all([
      worker.claimDue('100', ['42']),
      writer.claimDue('100', ['42']),
    ]);
    const [topic] = results.flat();
    expect(results.flat()).toEqual([
      { groupId: '42', activityVersion: '2', context: [first, second] },
    ]);
    if (!topic) throw new Error('Expected one claimed topic.');
    const claimed = await schedule();
    const delay = claimed.next_run_at.getTime() - Date.now();
    expect(delay).toBeGreaterThan(899_000);
    expect(delay).toBeLessThanOrEqual(1_201_000);
    expect(await worker.isCurrent('100', topic)).toBe(true);

    await dueNow();
    expect(await worker.claimDue('100', ['42'])).toEqual([]);
    await writer.append(
      '100',
      '42',
      { speaker: 'C', text: '后来改成周三' },
      true,
    );
    expect(await worker.isCurrent('100', topic)).toBe(false);
    await fixture.db
      .updateTable('group_topic_schedules')
      .set({ last_activity_at: sql<Date>`now() - interval '2 hours'` })
      .where('bot_id', '=', '100')
      .where('group_id', '=', '42')
      .execute();
    await dueNow();
    expect(await worker.claimDue('100', ['42'])).toEqual([]);
  } finally {
    await reopened.destroy();
    await fixture.close();
  }
});
