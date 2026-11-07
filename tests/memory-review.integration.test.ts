import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  MarkdownMemory,
  MemoryReview,
  TurnRunner,
} from '../packages/core/src/index.js';
import {
  createDatabase,
  createGroupMemoryReviewStore,
} from '../packages/database/src/index.js';
import { createTestDatabase } from './helpers/database.js';
import { sdkModel, sdkResult } from './helpers/model.js';

it('leases durable review batches and checkpoints only the claimed messages', async () => {
  const fixture = await createTestDatabase();
  const reopened = createDatabase(fixture.connectionString);
  const store = createGroupMemoryReviewStore(fixture.db);
  const other = createGroupMemoryReviewStore(reopened);
  const due = () =>
    fixture.db
      .updateTable('group_memory_schedules')
      .set({ next_run_at: sql<Date>`now() - interval '1 second'` })
      .execute();
  const line = {
    userId: '7',
    speaker: 'A',
    text: '喜欢科幻',
    sentAt: '2026-11-07T02:51:08Z',
  };
  try {
    await store.append('100', '42', line);
    expect(await other.claimDue('100', ['42'])).toBeUndefined();
    await due();
    expect(await other.claimDue('999', ['42'])).toBeUndefined();
    const claims = await Promise.all([
      store.claimDue('100', ['42']),
      other.claimDue('100', ['42']),
    ]);
    const batches = claims.filter((b) => b !== undefined);
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    if (!batch) throw new Error('Missing batch.');
    expect(batch.lines).toEqual([line]);
    await other.append('100', '42', { ...line, text: '刚收到的下一条' });
    await store.finish(batch, false);
    await due();
    const retry = await other.claimDue('100', ['42']);
    if (!retry) throw new Error('Missing retry.');
    expect(retry.lines).toHaveLength(2);
    expect(await store.renewLease(batch)).toBe(false);
    await expect(store.finish(batch, true)).rejects.toThrow('lease');
    await store.append('100', '42', { ...line, text: '回顾期间的新消息' });
    await other.finish(retry, true);
    const next = await store.claimDue('100', ['42']);
    expect(next?.lines.map((l) => l.text)).toEqual(['回顾期间的新消息']);
    if (!next) throw new Error('Missing next batch.');
    await fixture.db
      .updateTable('group_memory_schedules')
      .set({ lease_until: sql<Date>`now() - interval '1 second'` })
      .execute();
    const reclaimed = await other.claimDue('100', ['42']);
    expect(reclaimed?.throughId).toBe(next.throughId);
    expect(reclaimed?.lease).not.toBe(next.lease);
  } finally {
    await reopened.destroy();
    await fixture.close();
  }
});

it('reviews multiple members with memory-only tools and waits for file writes before checkpointing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-review-'));
  const memory = new MarkdownMemory(root, vi.fn());
  const finish = vi.fn(async (_batch, success: boolean) => {
    expect(success).toBe(true);
    expect(
      await readFile(join(root, 'user/7/group/42/兴趣.md'), 'utf8'),
    ).toContain('科幻');
    expect(
      await readFile(join(root, 'user/8/group/42/兴趣.md'), 'utf8'),
    ).toContain('摄影');
  });
  const calls = [
    ['list_memory', { scope: 'group' }],
    ['list_memory', { scope: 'user', userId: '7' }],
    [
      'write_memory',
      {
        scope: 'user',
        userId: '7',
        filename: '兴趣.md',
        content: 'A 自述喜欢科幻。',
      },
    ],
    ['list_memory', { scope: 'user', userId: '8' }],
    [
      'write_memory',
      {
        scope: 'user',
        userId: '8',
        filename: '兴趣.md',
        content: 'B 自述喜欢摄影。',
      },
    ],
    ['finish_review', {}],
  ] as const;
  let step = 0;
  const model = sdkModel(({ prompt, tools }) => {
    expect(tools?.map((t) => t.name)).not.toContain('send_message');
    expect(JSON.stringify(prompt)).toContain('2026-11-07T10:51:08.000+08:00');
    const call = calls[step++];
    if (!call) return sdkResult([{ type: 'text', text: 'REVIEW_COMPLETE' }]);
    return sdkResult(
      [
        {
          type: 'tool-call',
          toolCallId: String(step),
          toolName: call[0],
          input: JSON.stringify(call[1]),
        },
      ],
      'tool-calls',
    );
  });
  const review = new MemoryReview(new TurnRunner(model), memory, {
    append: vi.fn(),
    claimDue: vi.fn(),
    renewLease: async () => true,
    finish,
  });
  try {
    await review.run({
      botId: '100',
      groupId: '42',
      lease: 'test',
      throughId: '2',
      lines: [
        {
          userId: '7',
          speaker: 'A',
          text: '喜欢科幻',
          sentAt: '2026-11-07T02:51:08Z',
        },
        { userId: '8', speaker: 'B', text: '喜欢摄影' },
      ],
    });
    expect(finish).toHaveBeenCalledOnce();
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});
