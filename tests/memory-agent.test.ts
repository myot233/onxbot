import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  ConversationAgent,
  GroupChat,
  MarkdownMemory,
  TurnRunner,
} from '../packages/core/src/index.js';
import type { ModelMessage } from '../packages/model/src/index.js';
import { sdkModel, sdkResult } from './helpers/model.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

it('keeps an ambient group turn silent when it only writes memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const errors = vi.fn();
  const memory = new MarkdownMemory(root, errors);
  const send = vi.fn(async () => true);
  let step = 0;
  const model = sdkModel(() =>
    step++ === 0
      ? call('write_memory', { filename: '会议.md', content: '周二见。' })
      : sdkResult([{ type: 'text', text: '记忆已保存。' }]),
  );
  const group = new GroupChat(model, {
    systemPrompt: 'Be concise.',
    spontaneous: true,
    agent: new ConversationAgent(new TurnRunner(model), memory),
  });
  const message = { roomId: '42', addressedTo: 'group' as const };

  try {
    await group.receive({ ...message, speaker: 'A', text: '哪天见？' }, send);
    await group.receive({ ...message, speaker: 'B', text: '周二见。' }, send);
    expect(send).not.toHaveBeenCalled();
    await memory.close();
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'group/42/会议.md'), 'utf8')).toBe(
      '周二见。\n',
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

function call(name: string, input: object = {}) {
  return sdkResult(
    [
      {
        type: 'tool-call',
        toolCallId: name,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
}

it('sends from the same SDK run while a Markdown write is blocked', async () => {
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
  const send = vi.fn(async (messages: readonly string[]) => messages);
  let step = 0;
  const agent = new ConversationAgent(
    new TurnRunner(
      sdkModel(({ prompt: messages }) => {
        switch (step++) {
          case 0:
            return call('write_memory', {
              filename: '会议.md',
              content: '# 会议\n周二见。',
            });
          case 1:
            expect(JSON.stringify(messages.at(-1))).toContain('后台写入队列');
            return call('send_message', { messages: ['周二见。'] });
          default:
            return sdkResult([]);
        }
      }),
    ),
    memory,
  );

  try {
    const turn = agent.run(prompt, { kind: 'group', id: '42' }, send);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith(['周二见。']),
    );
    await expect(
      readFile(join(root, 'group/42/会议.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(turn).resolves.toEqual({
      reply: '周二见。',
      messages: [{ role: 'assistant', content: '周二见。' }],
    });
    release();
    await memory.close();
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'group/42/会议.md'), 'utf8')).toBe(
      '# 会议\n周二见。\n',
    );

    const reloaded = new MarkdownMemory(root, errors);
    const ask = (kind: 'group' | 'user') => {
      let step = 0;
      const reader = new ConversationAgent(
        new TurnRunner(
          sdkModel(({ prompt: messages }) => {
            if (step++ === 0) return call('list_memory');
            const output = JSON.stringify(messages.at(-1));
            if (step === 2) {
              if (kind === 'user') {
                expect(output).not.toContain('会议.md');
                return sdkResult([{ type: 'text', text: '没有用户记忆。' }]);
              }
              expect(output).toContain('会议.md');
              return call('read_memory', { filename: '会议.md' });
            }
            expect(output).toContain('周二见。');
            return sdkResult([{ type: 'text', text: '会议在周二。' }]);
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

it('sends each short group reply separately and in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const memory = new MarkdownMemory(root, vi.fn());
  const { promise: first, resolve: release } = Promise.withResolvers<boolean>();
  const send = vi.fn(async (_text: string, index: number) =>
    index === 0 ? first : true,
  );
  let step = 0;
  const model = sdkModel(() =>
    step++ === 0
      ? call('send_message', {
          messages: ['可以。', '周二见。', '带上会议记录。'],
        })
      : sdkResult([]),
  );
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

it('starts a scheduled topic from recent group context once per new activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-'));
  const memory = new MarkdownMemory(root, vi.fn());
  const send = vi.fn(async () => true);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  let step = 0;
  const model = sdkModel(({ prompt }) => {
    if (step++ === 0) {
      expect(JSON.stringify(prompt)).toContain('scheduled_topic');
      expect(JSON.stringify(prompt)).toContain('周二');
      return call('send_message', {
        messages: ['说到周二，有人想一起喝咖啡吗？'],
      });
    }
    return sdkResult([]);
  });
  const group = new GroupChat(model, {
    systemPrompt: 'Be concise.',
    spontaneous: false,
    agent: new ConversationAgent(new TurnRunner(model), memory),
  });
  const message = { roomId: '42', addressedTo: 'group' as const, speaker: 'A' };
  try {
    await group.receive({ ...message, text: '周二有空' }, send);
    await group.initiateTopic('42', send);
    expect(step).toBe(0);

    await group.receive({ ...message, text: '想找家咖啡馆' }, send);
    await group.initiateTopic('42', send);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      '说到周二，有人想一起喝咖啡吗？',
      0,
    );

    clock.mockReturnValue(2_000_000);
    await group.initiateTopic('42', send);
    expect(step).toBe(2);

    await group.receive({ ...message, text: '再想想' }, send);
    clock.mockReturnValue(6_000_000);
    await group.initiateTopic('42', send);
    expect(step).toBe(2);
  } finally {
    clock.mockRestore();
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});
