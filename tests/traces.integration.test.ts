import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { TraceRecorder } from '../apps/dashboard/src/traces.js';
import {
  createDatabase,
  createTraceStore,
} from '../packages/database/src/index.js';
import { createTestDatabase } from './helpers/database.js';

it('keeps ordered isolated traces and durable IDs across recorder and database-client restarts', async () => {
  const fixture = await createTestDatabase();
  const store = createTraceStore(fixture.db);
  const errors = vi.fn();
  const recorder = new TraceRecorder(store, errors);
  try {
    await recorder.initialize();
    await Promise.all(
      ['group/42', 'user/13'].map((session) =>
        recorder.run(session, async () => {
          recorder.record({
            phase: 'input',
            data: { text: session, providerOptions: { apiKey: 'never-store' } },
          });
          await Promise.resolve();
          recorder.record({ phase: 'output', data: { text: session } });
        }),
      ),
    );
    await recorder.close();
    const page = await store.list({ limit: 50 });
    expect(page.traces).toHaveLength(2);
    const latest = page.traces[0];
    if (!latest) throw new Error('Expected a persisted span');
    const snapshot = await store.get(latest.id);
    expect(snapshot?.events.map((e) => e.phase)).toEqual(['input', 'output']);
    expect(
      snapshot?.events.every((e) => e.content.includes(snapshot.session)),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('never-store');
    const reopened = createDatabase(fixture.connectionString);
    try {
      const restarted = createTraceStore(reopened);
      expect(await restarted.get(latest.id)).toEqual(snapshot);
      const next = await restarted.start('group/42', 'new-process');
      expect(next).toBeGreaterThan(latest.id);
      await restarted.finish(next, '失败', false);
      expect(await restarted.get(next)).toMatchObject({
        status: '失败',
        events: [],
      });
      expect((await restarted.get(next))?.finishedAt).toBeDefined();
    } finally {
      await reopened.destroy();
    }
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await recorder.close();
    await fixture.close();
  }
});

it('paginates stored history beyond fifty spans without mixing sessions or losing rows to new inserts', async () => {
  const fixture = await createTestDatabase();
  const store = createTraceStore(fixture.db);
  try {
    for (let i = 0; i < 55; i++) {
      const id = await store.start(i % 2 ? 'group/42' : 'user/13', 'process');
      await store.finish(id, '完成', false);
    }
    const first = await store.list({ limit: 50 });
    expect(first.traces).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();
    if (first.nextCursor === undefined) throw new Error('Expected a next page');
    await store.start('group/42', 'process');
    const second = await store.list({ limit: 50, before: first.nextCursor });
    expect(second.traces).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    expect(
      new Set([...first.traces, ...second.traces].map((t) => t.id)).size,
    ).toBe(55);
    const group = await store.list({
      limit: 100,
      session: 'group/42',
      status: '完成',
    });
    expect(group.traces).toHaveLength(27);
    expect(
      (await store.list({ limit: 100, search: 'GROUP/42' })).traces,
    ).toHaveLength(28);
    expect((await store.list({ limit: 50, search: '%_' })).traces).toHaveLength(
      0,
    );
    expect(
      (await store.list({ limit: 50, search: "' OR true --" })).traces,
    ).toHaveLength(0);
    expect(await store.get(999999)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

it('commits events and counts atomically, keeps duplicate appends idempotent, and recovers only expired foreign spans', async () => {
  const fixture = await createTestDatabase();
  const store = createTraceStore(fixture.db);
  try {
    const id = await store.start('group/42', 'active');
    const event = { phase: 'input' as const, content: '{}' };
    await Promise.all([
      store.append(id, 0, event, false),
      store.append(id, 0, event, false),
    ]);
    expect((await store.list({ limit: 50 })).traces[0]?.eventCount).toBe(1);
    await expect(
      store.append(id, 1, { phase: 'output', content: '\u0000' }, true),
    ).rejects.toThrow();
    expect((await store.get(id))?.events).toHaveLength(1);
    expect((await store.get(id))?.truncated).toBe(false);
    const orphan = await store.start('group/42', 'dead-process');
    const foreign = await store.start('user/13', 'other-live-process');
    await fixture.db
      .updateTable('model_traces')
      .set({ lease_until: sql`now() - interval '1 second'` })
      .where('id', 'in', [id, orphan])
      .execute();
    await store.maintain('active', [id]);
    expect((await store.get(id))?.status).toBe('运行中');
    expect((await store.get(foreign))?.status).toBe('运行中');
    expect(await store.get(orphan)).toMatchObject({ status: '中断' });
    expect((await store.get(orphan))?.finishedAt).toBeUndefined();
    await fixture.db
      .updateTable('model_traces')
      .set({ lease_until: sql`now() - interval '1 second'` })
      .where('id', '=', id)
      .execute();
    await store.maintain('active', []);
    expect((await store.get(id))?.status).toBe('中断');
  } finally {
    await fixture.close();
  }
});
