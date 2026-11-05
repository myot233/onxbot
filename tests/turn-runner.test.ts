import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ContextBuilder,
  defineTool,
  TurnRunner,
} from '../packages/core/src/index.js';
import { sdkModel, sdkResult } from './helpers/model.js';

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

function callWeather(input: string) {
  return sdkResult(
    [{ type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input }],
    'tool-calls',
  );
}

describe('model and tool execution', () => {
  it('executes validated tools and stores the SDK transcript', async () => {
    const model = sdkModel(({ prompt, tools }) => {
      expect(tools?.[0]).toMatchObject({ name: 'weather' });
      const last = prompt.at(-1);
      if (last?.role !== 'tool') return callWeather('{"city":"Hangzhou"}');
      const result = last.content[0];
      expect(result).toMatchObject({
        type: 'tool-result',
        toolName: 'weather',
        output: { type: 'text', value: 'Hangzhou: sunny' },
      });
      return sdkResult([{ type: 'text', text: 'forecast: Hangzhou: sunny' }]);
    });
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
    expect(result.messages).toMatchObject([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'weather',
            input: { city: 'Hangzhou' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'weather',
            output: { type: 'text', value: 'Hangzhou: sunny' },
          },
        ],
      },
      { role: 'assistant', content: 'forecast: Hangzhou: sunny' },
    ]);
  });

  it('rejects invalid arguments before executing a tool', async () => {
    let executed = false;
    const runner = new TurnRunner(
      sdkModel(() => callWeather('{"city":42}')),
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
      sdkModel(() => callWeather('{}')),
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
      'tool choice was none',
    );
    expect(executions).toBe(1);
  });
});
