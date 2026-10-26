import { match } from 'ts-pattern';
import { z } from 'zod';
import type { ChatProvider } from './types.js';

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
  message: z.object({ content: z.string().trim().min(1) }),
});
const completionResponse = z.object({
  choices: z.tuple([completionChoice]).rest(completionChoice),
});

export function createChatProvider(config: ProviderConfig): ChatProvider {
  return match(config)
    .with(
      { type: 'echo' },
      () =>
        ({
          async complete(messages) {
            const latest = messages.findLast(
              (message) => message.role === 'user',
            );
            return `收到：${latest?.content ?? ''}`;
          },
        }) satisfies ChatProvider,
    )
    .with(
      { type: 'openai' },
      (options) =>
        ({
          async complete(messages) {
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
                  messages,
                  stream: false,
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
            return parsed.data.choices[0].message.content;
          },
        }) satisfies ChatProvider,
    )
    .exhaustive();
}
