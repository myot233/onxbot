import type { ChatOptions } from '@onxbot/core';
import type { ProviderConfig } from '@onxbot/model';
import { match } from 'ts-pattern';
import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const groupIds = z
  .string()
  .default('')
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(z.string().regex(/^\d+$/)));
const environment = z.object({
  OBSERVE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  OBSERVE_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  OBSERVE_PASSWORD: z
    .string()
    .regex(/^[\x21-\x7e]{24,128}$/)
    .optional(),
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
  DEEPSEEK_REASONING_EFFORT: z.enum(['low', 'high', 'max']).optional(),
  CHAT_SYSTEM_PROMPT: nonempty.default('你是一个友善、简洁的中文对话助手。'),
  CHAT_GROUP_SYSTEM_PROMPT: z.string().trim().default(''),
  CHAT_MEMORY_DIR: nonempty.default('memory'),
  CHAT_HISTORY_TURNS: z.coerce.number().int().min(0).max(100).default(10),
  CHAT_GROUP_IDS: groupIds,
  CHAT_TOPIC_GROUP_IDS: groupIds,
  CHAT_FEEDBACK_GROUP_IDS: groupIds,
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
  observe?: { host: string; port: number; password: string };
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
  groupIds: readonly string[];
  topicGroupIds: readonly string[];
  feedbackGroupIds: readonly string[];
  groupSystemPrompt: string;
  memoryDir: string;
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
  if (env.OBSERVE_PORT && !env.OBSERVE_PASSWORD)
    throw new Error('OBSERVE_PASSWORD is required when OBSERVE_PORT is set.');
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
        ...(env.DEEPSEEK_REASONING_EFFORT && {
          deepSeekReasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
        }),
        timeoutMs: env.CHAT_TIMEOUT_MS,
      };
    })
    .exhaustive();
  return {
    ...(env.OBSERVE_PORT &&
      env.OBSERVE_PASSWORD && {
        observe: {
          host: env.OBSERVE_HOST,
          port: env.OBSERVE_PORT,
          password: env.OBSERVE_PASSWORD,
        },
      }),
    databaseUrl: env.DATABASE_URL,
    onebot: {
      protocol: 'ws',
      selfId: env.ONEBOT_SELF_ID,
      endpoint: env.ONEBOT_ENDPOINT,
      token: env.ONEBOT_TOKEN,
      responseTimeout: 10_000,
    },
    provider,
    groupIds: env.CHAT_GROUP_IDS,
    topicGroupIds: env.CHAT_TOPIC_GROUP_IDS,
    feedbackGroupIds: env.CHAT_FEEDBACK_GROUP_IDS,
    groupSystemPrompt: env.CHAT_GROUP_SYSTEM_PROMPT || env.CHAT_SYSTEM_PROMPT,
    memoryDir: env.CHAT_MEMORY_DIR,
    chat: {
      systemPrompt: env.CHAT_SYSTEM_PROMPT,
      historyTurns: env.CHAT_HISTORY_TURNS,
      maxInputChars: env.CHAT_MAX_INPUT_CHARS,
    },
  };
}
