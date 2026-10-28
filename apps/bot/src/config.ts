import type { ChatOptions } from '@onxbot/core';
import type { ProviderConfig } from '@onxbot/model';
import { match } from 'ts-pattern';
import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const environment = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ONEBOT_SELF_ID: z.string().regex(/^\d+$/),
  ONEBOT_ENDPOINT: z.url({ protocol: /^wss?$/ }),
  ONEBOT_TOKEN: nonempty,
  CHAT_PROVIDER: z.enum(['echo', 'openai']).default('echo'),
  OPENAI_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().trim().default(''),
  OPENAI_MODEL: nonempty.default('gpt-4.1-mini'),
  CHAT_SYSTEM_PROMPT: nonempty.default('你是一个友善、简洁的中文对话助手。'),
  CHAT_HISTORY_TURNS: z.coerce.number().int().min(0).max(100).default(10),
  CHAT_MAX_INPUT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .max(100_000)
    .default(8000),
  CHAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(30_000),
});

export interface BotConfig {
  databaseUrl: string;
  onebot: {
    protocol: 'ws';
    selfId: string;
    endpoint: string;
    token: string;
    responseTimeout: number;
  };
  provider: ProviderConfig;
  chat: ChatOptions;
}

export function loadConfig(
  values: Record<string, string | undefined>,
): BotConfig {
  const parsed = environment.safeParse(values);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const env = parsed.data;
  const provider = match(env.CHAT_PROVIDER)
    .returnType<ProviderConfig>()
    .with('echo', () => ({ type: 'echo' }))
    .with('openai', () => {
      if (!env.OPENAI_API_KEY)
        throw new Error(
          'OPENAI_API_KEY is required when CHAT_PROVIDER=openai.',
        );
      return {
        type: 'openai',
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
        timeoutMs: env.CHAT_TIMEOUT_MS,
      };
    })
    .exhaustive();
  return {
    databaseUrl: env.DATABASE_URL,
    onebot: {
      protocol: 'ws',
      selfId: env.ONEBOT_SELF_ID,
      endpoint: env.ONEBOT_ENDPOINT,
      token: env.ONEBOT_TOKEN,
      responseTimeout: 10_000,
    },
    provider,
    chat: {
      systemPrompt: env.CHAT_SYSTEM_PROMPT,
      historyTurns: env.CHAT_HISTORY_TURNS,
      maxInputChars: env.CHAT_MAX_INPUT_CHARS,
    },
  };
}
