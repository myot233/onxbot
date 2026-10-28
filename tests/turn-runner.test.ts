import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ContextBuilder,
  defineTool,
  TurnRunner,
} from '../packages/core/src/index.js';
import type {
  ModelMessage,
  ModelProvider,
} from '../packages/model/src/index.js';

async function context() {
  return new ContextBuilder({
    systemPrompt: 'Be concise.',
    historyTurns: 0,
  }).build({
    identity: { platform: 'onebot', botId: '1', channelId: '2', userId: '3' },
    input: 'weather in Hangzhou',
    history: [],
  });
}

describe('model and tool execution', () => {
  it('executes validated tool calls and returns the complete transcript', async () => {
    const requests: ModelMessage[][] = [];
    const model: ModelProvider = {
      async generate({ messages, tools }) {
        requests.push([...messages]);
        expect(tools?.[0]?.name).toBe('weather');
        return requests.length === 1
          ? {
              type: 'tool-calls',
              text: '',
              calls: [
                { id: 'c1', name: 'weather', arguments: '{"city":"Hangzhou"}' },
              ],
            }
          : { type: 'reply', text: `forecast: ${messages.at(-1)?.content}` };
      },
    };
    const runner = new TurnRunner(model, {
      tools: [
        defineTool({
          name: 'weather',
          description: 'Get the weather',
          input: z.object({ city: z.string() }),
          async execute({ city }) {
            return `${city}: sunny`;
          },
        }),
      ],
    });
    const result = await runner.run(await context());
    expect(result.reply).toBe('forecast: Hangzhou: sunny');
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'weather', arguments: '{"city":"Hangzhou"}' },
        ],
      },
      { role: 'tool', content: 'Hangzhou: sunny', toolCallId: 'c1' },
      { role: 'assistant', content: 'forecast: Hangzhou: sunny' },
    ]);
    expect(requests[1]?.slice(-2)).toEqual(result.messages.slice(0, 2));
  });

  it('rejects invalid arguments before executing a tool', async () => {
    let executed = false;
    const runner = new TurnRunner(
      {
        async generate() {
          return {
            type: 'tool-calls',
            text: '',
            calls: [{ id: 'c1', name: 'weather', arguments: '{"city":42}' }],
          };
        },
      },
      {
        tools: [
          defineTool({
            name: 'weather',
            description: 'Weather',
            input: z.object({ city: z.string() }),
            async execute() {
              executed = true;
              return 'sunny';
            },
          }),
        ],
      },
    );
    await expect(runner.run(await context())).rejects.toThrow();
    expect(executed).toBe(false);
  });

  it('stops at the model call limit before executing another tool', async () => {
    let executions = 0;
    const runner = new TurnRunner(
      {
        async generate() {
          return {
            type: 'tool-calls',
            text: '',
            calls: [{ id: 'c1', name: 'weather', arguments: '{}' }],
          };
        },
      },
      {
        maxModelCalls: 2,
        tools: [
          defineTool({
            name: 'weather',
            description: 'Weather',
            input: z.object({}),
            async execute() {
              executions += 1;
              return 'sunny';
            },
          }),
        ],
      },
    );
    await expect(runner.run(await context())).rejects.toThrow(
      'Model call limit',
    );
    expect(executions).toBe(1);
  });
});
