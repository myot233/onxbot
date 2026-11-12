import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  ConversationAgent,
  GroupChat,
  MarkdownMemory,
  type MemoryScope,
  TurnRunner,
} from '../packages/core/src/index.js';
import type { ModelMessage } from '../packages/model/src/index.js';
import { piModel, piResult } from './helpers/model.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readdir: vi.fn(fs.readdir), writeFile: vi.fn(fs.writeFile) };
});

it('keeps an ambient group turn silent when it only writes memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  const send = vi.fn(async () => true);
  let step = 0;
  const sentAt = '2026-11-06T16:35:18.000Z';
  const model = piModel(({ prompt }) => {
    if (step++ > 0) return piResult([{ type: 'text', text: '记忆已保存。' }]);
    expect(JSON.stringify(prompt)).toContain('2026-11-07T00:35:18.000+08:00');
    return call('write_memory', { filename: '会议.md', content: '周二见。' });
  });
  const group = new GroupChat(model, {
    systemPrompt: 'Be concise.',
    spontaneous: true,
    agent: new ConversationAgent(new TurnRunner(model), memory),
  });
  const message = { roomId: '42', addressedTo: 'group' as const };

  try {
    await group.receive({ ...message, speaker: 'A', text: '哪天见？' }, send);
    await group.receive(
      { ...message, speaker: 'B', text: '周二见。', sentAt },
      send,
    );
    expect(send).not.toHaveBeenCalled();
    await memory.close();
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'group/42/会议.md'), 'utf8')).toMatch(
      /^周二见。\n\nRecorded at: \d{4}-\d\d-\d\dT[^\n]+\+08:00\n$/,
    );
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

const prompt = {
  messages: (output: readonly ModelMessage[] = []): ModelMessage[] => [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Remember that we meet on Tuesday.' },
    ...output,
  ],
};

function call(name: string, input: object = {}, id = name) {
  return piResult(
    [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
}

it('sends from the same agent run while a Markdown write is blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await blocked;
    await fs.writeFile(...args);
  });
  const send = vi.fn(async (_text: string) => true);
  let step = 0;
  const agent = new ConversationAgent(
    new TurnRunner(
      piModel(({ prompt: messages }) => {
        switch (step++) {
          case 0:
            return call('write_memory', {
              filename: '会议.md',
              content: '# 会议\n周二见。',
            });
          case 1:
            expect(JSON.stringify(messages.at(-1))).toContain('后台写入队列');
            return call('send_message', { text: '周二见。' });
          default:
            return piResult([]);
        }
      }),
    ),
    memory,
  );

  try {
    const turn = agent.run(prompt, { kind: 'group', id: '42' }, send);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith('周二见。'),
    );
    await expect(
      readFile(join(root, 'group/42/会议.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await memory.listDocuments()).toContain('group/42/会议.md');
    expect(await memory.readDocument('group/42/会议.md')).toContain('周二见。');
    await expect(turn).resolves.toEqual({
      reply: '周二见。',
      messages: [{ role: 'assistant', content: '周二见。' }],
    });
    release();
    await memory.close();
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'group/42/会议.md'), 'utf8')).toMatch(
      /^# 会议\n周二见。\n\nRecorded at: \d{4}-\d\d-\d\dT[^\n]+\+08:00\n$/,
    );

    const reloaded = new MarkdownMemory(root, errors);
    const ask = (kind: 'group' | 'user') => {
      let step = 0;
      const reader = new ConversationAgent(
        new TurnRunner(
          piModel(({ prompt: messages }) => {
            if (step++ === 0) return call('list_memory');
            const output = JSON.stringify(messages.at(-1));
            if (step === 2) {
              if (kind === 'user') {
                expect(output).not.toContain('会议.md');
                return piResult([{ type: 'text', text: '没有用户记忆。' }]);
              }
              expect(output).toContain('会议.md');
              return call('read_memory', { filename: '会议.md' });
            }
            expect(output).toContain('周二见。');
            return piResult([{ type: 'text', text: '会议在周二。' }]);
          }),
        ),
        reloaded,
      );
      return reader.run(prompt, { kind, id: '42' });
    };
    expect((await ask('group')).reply).toBe('会议在周二。');
    expect((await ask('user')).reply).toBe('没有用户记忆。');
    await reloaded.close();
  } finally {
    release();
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports failed writes at flush and continues processing queued notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  const failure = new Error('Disk write failed');
  vi.mocked(writeFile).mockRejectedValueOnce(failure);
  let step = 0;
  const agent = new ConversationAgent(
    new TurnRunner(
      piModel(() => {
        switch (step++) {
          case 0:
            return call('write_memory', {
              filename: '失败.md',
              content: '未保存',
            });
          case 1:
            return call('write_memory', {
              filename: '活动.md',
              content: '周二见',
            });
          default:
            return piResult([{ type: 'text', text: '已记录' }]);
        }
      }),
    ),
    memory,
  );

  try {
    await agent.run(prompt, { kind: 'group', id: '42' });
    await expect(memory.flush()).rejects.toThrow('memory write failed');
    expect(errors).toHaveBeenCalledExactlyOnceWith(failure);
    expect(await readFile(join(root, 'group/42/活动.md'), 'utf8')).toContain(
      '周二见',
    );
    await expect(
      readFile(join(root, 'group/42/失败.md')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(memory.flush()).resolves.toBeUndefined();
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('lists a queued note even when it lands between directory enumeration and the pending scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  const started = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    started.resolve();
    await write.promise;
    await fs.writeFile(...args);
  });
  vi.mocked(readdir).mockImplementationOnce(async (...args) => {
    const listing = await fs.readdir(...args);
    write.resolve();
    await memory.flush();
    return listing;
  });
  let step = 0;
  const agent = new ConversationAgent(
    new TurnRunner(
      piModel(async ({ prompt }) => {
        switch (step++) {
          case 0:
            return call('write_memory', {
              filename: 'club.md',
              content: 'Weekly reading club.',
            });
          case 1:
            await started.promise;
            return call('list_memory');
          default:
            expect(JSON.stringify(prompt.at(-1))).toContain('club.md');
            return piResult([{ type: 'text', text: 'Done' }]);
        }
      }),
    ),
    memory,
  );
  try {
    await agent.run(prompt, { kind: 'group', id: '42' });
    expect(readdir).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    write.resolve();
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('replaces copied metadata with one storage footer on repeated writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  let step = 0;
  let staged = '';
  const agent = new ConversationAgent(
    new TurnRunner(
      piModel(({ prompt }) => {
        switch (step++) {
          case 0:
            return call('write_memory', {
              filename: 'club.md',
              content:
                '# Club\n\nsource=2026-01-02 19:45Z\n\nRecorded at: 2026-01-03T03:50+08:00\n\nUpdated: 2026-01-03T04:00+08:00',
            });
          case 1:
            return call('read_memory', { filename: 'club.md' });
          case 2: {
            const result = prompt.at(-1);
            const part =
              result?.role === 'tool' ? result.content[0] : undefined;
            if (part?.type !== 'tool-result' || part.output.type !== 'text')
              throw new Error('Expected staged note');
            staged = part.output.value;
            return call('write_memory', {
              filename: 'club.md',
              content: `${staged}\nUpdated: 2026-01-03T05:00+08:00\n\nThe club meets weekly.`,
            });
          }
          default:
            return piResult([{ type: 'text', text: 'Done' }]);
        }
      }),
    ),
    memory,
  );
  try {
    await agent.run(prompt, { kind: 'group', id: '42' });
    await memory.flush();
    const stored = await readFile(join(root, 'group/42/club.md'), 'utf8');
    for (const note of [staged, stored]) {
      expect(note.match(/^Recorded at:/gm)).toHaveLength(1);
      expect(note).not.toContain('Updated:');
      expect(note).toContain('source=2026-01-03T03:45+08:00');
      expect(note).toMatch(/\n\nRecorded at: \d{4}-\d\d-\d\dT[^\n]+\+08:00\n$/);
    }
    expect(stored).toContain('The club meets weekly.');
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a metadata-only note without creating a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const memory = new MarkdownMemory(root, vi.fn());
  let step = 0;
  const agent = new ConversationAgent(
    new TurnRunner(
      piModel(({ prompt }) => {
        if (step++ === 0)
          return call('write_memory', {
            filename: 'empty.md',
            content: 'Recorded at: 2026-01-02T09:30+08:00',
          });
        expect(JSON.stringify(prompt.at(-1))).toContain('记忆正文为空');
        return piResult([{ type: 'text', text: 'Done' }]);
      }),
    ),
    memory,
  );
  try {
    await agent.run(prompt, { kind: 'group', id: '42' });
    await memory.flush();
    await expect(
      readFile(join(root, 'group/42/empty.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('sends each short group reply separately and in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const memory = new MarkdownMemory(root, vi.fn());
  const { promise: first, resolve: release } = Promise.withResolvers<boolean>();
  const send = vi.fn(async (_text: string, index: number) =>
    index === 0 ? first : true,
  );
  let step = 0;
  const model = piModel(({ prompt }) => {
    switch (step++) {
      case 0:
        return {
          content: [
            ...call('send_message', { text: '可以。' }, 'send-1').content,
            ...call('send_message', { text: '周二见。' }, 'send-2').content,
          ],
          stopReason: 'toolUse',
        };
      case 1:
        expect(JSON.stringify(prompt.at(-1))).toContain('消息已发出');
        return call('list_memory');
      case 2:
        return call('send_message', { text: '带上会议记录。' }, 'send-3');
      default:
        return piResult([]);
    }
  });
  const group = new GroupChat(model, {
    systemPrompt: 'Be concise.',
    spontaneous: false,
    agent: new ConversationAgent(new TurnRunner(model), memory),
  });
  const observe = vi.fn();
  const turn = group.receive(
    { roomId: '42', addressedTo: 'bot', speaker: 'A', text: '周二怎么安排？' },
    send,
    observe,
  );
  try {
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith('可以。', 0),
    );
    release(true);
    await turn;
    expect(send.mock.calls).toEqual([
      ['可以。', 0],
      ['周二见。', 1],
      ['带上会议记录。', 2],
    ]);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'sent',
        reply: '可以。\n周二见。\n带上会议记录。',
      }),
    );
  } finally {
    release(false);
    await turn.catch(() => {});
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('starts a scheduled topic from restored context without receiving live messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const memory = new MarkdownMemory(root, vi.fn());
  const send = vi.fn(async () => true);
  let step = 0;
  const model = piModel(({ prompt }) => {
    if (step++ === 0) {
      expect(JSON.stringify(prompt)).toContain('scheduled_topic');
      expect(JSON.stringify(prompt)).toContain('周二');
      return call('send_message', {
        text: '周二已经有咖啡味了',
      });
    }
    return piResult([]);
  });
  const group = new GroupChat(model, {
    systemPrompt: 'Be concise.',
    spontaneous: false,
    agent: new ConversationAgent(new TurnRunner(model), memory),
  });
  const saved = [
    { speaker: 'A', text: '周二有空' },
    { speaker: 'B', text: '想找家咖啡馆' },
  ];
  try {
    await group.initiateTopic('42', saved.slice(0, 1), send);
    expect(step).toBe(0);
    await group.initiateTopic('42', saved, send);
    expect(send).toHaveBeenCalledExactlyOnceWith('周二已经有咖啡味了', 0);
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('saves group facts and member preferences silently in isolated scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  const send = vi.fn(async () => true);
  const model = piModel(({ prompt }) => {
    if (prompt.at(-1)?.role === 'tool') return piResult([]);
    return {
      content: [
        ...call(
          'write_memory',
          { scope: 'group', filename: '活动.md', content: '每周二读书会。' },
          'group-write',
        ).content,
        ...call(
          'write_memory',
          { scope: 'user', filename: '偏好.md', content: '喜欢科幻小说。' },
          'member-write',
        ).content,
      ],
      stopReason: 'toolUse',
    };
  });
  const group = new GroupChat(model, {
    systemPrompt: 'Be concise.',
    spontaneous: false,
    agent: new ConversationAgent(new TurnRunner(model), memory),
  });
  try {
    await group.receive(
      {
        roomId: '42',
        userId: '7',
        addressedTo: 'bot',
        speaker: 'A',
        text: '每周二读书会，我喜欢科幻小说。',
      },
      send,
    );
    expect(send).not.toHaveBeenCalled();

    async function list(scope: MemoryScope, requested: 'group' | 'user') {
      const reader = new ConversationAgent(
        new TurnRunner(
          piModel(({ prompt }) => {
            const result = prompt.at(-1);
            if (result?.role !== 'tool')
              return call('list_memory', { scope: requested });
            const part = result.content[0];
            if (part?.type !== 'tool-result' || part.output.type !== 'text')
              throw new Error('Expected memory filenames.');
            return piResult([{ type: 'text', text: part.output.value }]);
          }),
        ),
        memory,
      );
      return (await reader.run(prompt, scope)).reply;
    }

    expect(await list({ kind: 'group', id: '42', userId: '7' }, 'user')).toBe(
      '["偏好.md"]',
    );
    expect(await list({ kind: 'group', id: '42', userId: '8' }, 'user')).toBe(
      '[]',
    );
    expect(await list({ kind: 'group', id: '43', userId: '7' }, 'user')).toBe(
      '[]',
    );
    expect(await list({ kind: 'user', id: '7' }, 'user')).toBe('[]');
    expect(await list({ kind: 'group', id: '42' }, 'group')).toBe(
      '["活动.md"]',
    );

    await memory.close();
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'group/42/活动.md'), 'utf8')).toMatch(
      /^每周二读书会。\n\nRecorded at: \d{4}-\d\d-\d\dT[^\n]+\+08:00\n$/,
    );
    expect(
      await readFile(join(root, 'user/7/group/42/偏好.md'), 'utf8'),
    ).toMatch(
      /^喜欢科幻小说。\n\nRecorded at: \d{4}-\d\d-\d\dT[^\n]+\+08:00\n$/,
    );
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});
