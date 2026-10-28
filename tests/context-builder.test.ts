import { describe, expect, it } from 'vitest';
import {
  ContextBuilder,
  ContextLimitError,
} from '../packages/core/src/index.js';

const identity = {
  platform: 'onebot',
  botId: '1',
  channelId: '2',
  userId: 'alice',
};

describe('context construction', () => {
  it('keeps complete turns, including tool calls, when selecting history', async () => {
    const builder = new ContextBuilder({
      systemPrompt: 'persona',
      historyTurns: 1,
    });
    const context = await builder.build({
      identity,
      input: 'next',
      history: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'weather' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'weather', arguments: '{}' }],
        },
        { role: 'tool', content: 'sunny', toolCallId: 'c1' },
        { role: 'assistant', content: 'It is sunny.' },
      ],
    });
    expect(context.messages().map((message) => message.content)).toEqual([
      'persona',
      'weather',
      '',
      'sunny',
      'It is sunny.',
      'next',
    ]);
  });

  it('loads named context sources with the current identity without retaining another user context', async () => {
    const builder = new ContextBuilder({
      systemPrompt: 'persona',
      historyTurns: 0,
      sources: [
        {
          name: 'preferences',
          async load({ identity }) {
            return `${identity.userId}: no spicy food`;
          },
        },
      ],
    });
    const alice = await builder.build({
      identity,
      input: 'dinner',
      history: [],
    });
    const bob = await builder.build({
      identity: { ...identity, userId: 'bob' },
      input: 'dinner',
      history: [],
    });
    expect(alice.messages()).toEqual([
      { role: 'system', content: 'persona' },
      {
        role: 'user',
        content: '参考资料（preferences）：\nalice: no spicy food',
      },
      { role: 'user', content: 'dinner' },
    ]);
    expect(JSON.stringify(bob.messages())).not.toContain('alice');
  });

  it('rechecks the budget as tool output grows and removes whole historical turns', async () => {
    const builder = new ContextBuilder({
      systemPrompt: 's',
      historyTurns: 2,
      budget: { maxTokens: 6, countTokens: (messages) => messages.length },
    });
    const context = await builder.build({
      identity,
      input: 'now',
      history: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'reply one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'reply two' },
      ],
    });
    expect(context.messages()).toHaveLength(6);
    expect(
      context
        .messages([
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'weather', arguments: '{}' }],
          },
          { role: 'tool', content: 'sunny', toolCallId: 'c1' },
        ])
        .map((message) => message.content),
    ).toEqual(['s', 'two', 'reply two', 'now', '', 'sunny']);
    expect(() =>
      context.messages(
        Array.from({ length: 6 }, () => ({
          role: 'assistant' as const,
          content: 'large',
        })),
      ),
    ).toThrow(ContextLimitError);
  });
});
