import { match } from 'ts-pattern';
import { z } from 'zod';
import type { ModelMessage, ModelProvider, ModelResponse } from './types.js';

export type ProviderConfig =
  | { type: 'echo' }
  | {
      type: 'openai';
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    };

const completionChoice = z.object({
  message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().min(1),
          type: z.literal('function'),
          function: z.object({
            name: z.string().min(1),
            arguments: z.string(),
          }),
        }),
      )
      .nullish(),
  }),
});
const completionResponse = z.object({
  choices: z.tuple([completionChoice]).rest(completionChoice),
});

function toWireMessage(message: ModelMessage) {
  return match(message)
    .with({ role: 'assistant' }, ({ role, content, toolCalls }) => ({
      role,
      content,
      ...(toolCalls?.length
        ? {
            tool_calls: toolCalls.map(({ id, name, arguments: args }) => ({
              id,
              type: 'function',
              function: { name, arguments: args },
            })),
          }
        : {}),
    }))
    .with({ role: 'tool' }, ({ role, content, toolCallId }) => ({
      role,
      content,
      tool_call_id: toolCallId,
    }))
    .with({ role: 'system' }, { role: 'user' }, ({ role, content }) => ({
      role,
      content,
    }))
    .exhaustive();
}

export function createModelProvider(config: ProviderConfig): ModelProvider {
  return match(config)
    .with(
      { type: 'echo' },
      () =>
        ({
          async generate({ messages }) {
            const latest = messages.findLast(
              (message) => message.role === 'user',
            );
            return { type: 'reply', text: `收到：${latest?.content ?? ''}` };
          },
        }) satisfies ModelProvider,
    )
    .with(
      { type: 'openai' },
      (options) =>
        ({
          async generate({ messages, tools }): Promise<ModelResponse> {
            const response = await fetch(
              `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${options.apiKey}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  model: options.model,
                  messages: messages.map(toWireMessage),
                  stream: false,
                  ...(tools?.length
                    ? {
                        tools: tools.map((definition) => ({
                          type: 'function',
                          function: definition,
                        })),
                      }
                    : {}),
                }),
                signal: AbortSignal.timeout(options.timeoutMs),
              },
            );
            if (!response.ok)
              throw new Error(
                `Model request failed (HTTP ${response.status}).`,
              );
            const parsed = completionResponse.safeParse(await response.json());
            if (!parsed.success)
              throw new Error('Model returned an invalid or empty completion.');
            const message = parsed.data.choices[0].message;
            if (message.tool_calls?.length) {
              return {
                type: 'tool-calls',
                text: message.content ?? '',
                calls: message.tool_calls.map((call) => ({
                  id: call.id,
                  ...call.function,
                })),
              };
            }
            const text = message.content?.trim();
            if (!text)
              throw new Error('Model returned an invalid or empty completion.');
            return { type: 'reply', text };
          },
        }) satisfies ModelProvider,
    )
    .exhaustive();
}
