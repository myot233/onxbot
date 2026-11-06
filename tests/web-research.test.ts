import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWebResearchTools } from '../apps/bot/src/web-research.js';
import {
  ConversationAgent,
  MarkdownMemory,
  TurnRunner,
} from '../packages/core/src/index.js';
import { sdkModel, sdkResult } from './helpers/model.js';

it('searches and reads a result in one agent turn with a bounded request budget', async () => {
  const url = 'https://example.org/memes';
  const request = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith('/search')
      ? Response.json({
          results: [{ title: '梗词资料', url, snippet: '一个网络梗' }],
        })
      : Response.json({ title: '梗词资料', content: '用来形容终于等到了。' }),
  );
  const root = await mkdtemp(join(tmpdir(), 'onxbot-web-'));
  const memory = new MarkdownMemory(root, vi.fn());
  let step = 0;
  const model = sdkModel(({ prompt }) => {
    const result = JSON.stringify(prompt.at(-1));
    const call = (toolName: string, input: object) =>
      sdkResult(
        [
          {
            type: 'tool-call',
            toolCallId: `tool-${step}`,
            toolName,
            input: JSON.stringify(input),
          },
        ],
        'tool-calls',
      );
    switch (step++) {
      case 0:
        return call('fetch_page', { url: 'http://127.0.0.1/internal' });
      case 1:
        expect(result).toContain('本轮搜索结果中的链接');
        return call('search_web', { query: '网络梗 含义' });
      case 2:
        expect(result).toContain(url);
        return call('fetch_page', { url });
      case 3:
        expect(result).toContain('用来形容终于等到了');
        return call('search_web', { query: '网络梗 出处' });
      case 4:
        return call('search_web', { query: '额外搜索' });
      case 5:
        expect(result).toContain('网页检索额度已用完');
        return call('send_message', { text: '这个梗是说终于等到了。' });
      default:
        return sdkResult([]);
    }
  });
  try {
    const agent = new ConversationAgent(
      new TurnRunner(model),
      memory,
      createWebResearchTools('test-key', request),
    );
    const send = vi.fn(async () => true);
    await agent.run(
      {
        messages: (output = []) => [
          { role: 'user', content: '这个梗什么意思？' },
          ...output,
        ],
      },
      { kind: 'group', id: '42' },
      send,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith('这个梗是说终于等到了。');
    expect(
      request.mock.calls.map(([input, init]) => [
        input,
        JSON.parse(String(init?.body)),
      ]),
    ).toEqual([
      [
        'https://api.deepseek.com/v1/tools/search',
        { query: '网络梗 含义', count: 3, need_content: false },
      ],
      ['https://api.deepseek.com/v1/tools/fetch', { url }],
      [
        'https://api.deepseek.com/v1/tools/search',
        { query: '网络梗 出处', count: 3, need_content: false },
      ],
    ]);
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'only delivers a plain-text search answer for direct requests (%s)',
  async (direct) => {
    const root = await mkdtemp(join(tmpdir(), 'onxbot-web-'));
    const memory = new MarkdownMemory(root, vi.fn());
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [] }),
    );
    const model = sdkModel(({ prompt }) =>
      prompt.at(-1)?.role === 'tool'
        ? sdkResult([{ type: 'text', text: '还没查到这个说法。' }])
        : sdkResult(
            [
              {
                type: 'tool-call',
                toolCallId: 'search',
                toolName: 'search_web',
                input: '{"query":"网络梗"}',
              },
            ],
            'tool-calls',
          ),
    );
    const send = vi.fn(async () => true);
    try {
      const agent = new ConversationAgent(
        new TurnRunner(model),
        memory,
        createWebResearchTools('test-key', request),
      );
      await agent.run(
        {
          messages: (output = []) => [
            { role: 'user', content: '这个梗什么意思？' },
            ...output,
          ],
        },
        { kind: 'group', id: '42' },
        send,
        { replyAfterLookup: direct },
      );
      if (direct)
        expect(send).toHaveBeenCalledExactlyOnceWith('还没查到这个说法。');
      else expect(send).not.toHaveBeenCalled();
    } finally {
      await memory.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
