import { randomUUID } from 'node:crypto';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { parseToolArguments } from './pi-messages.js';
import { createPiModelProvider } from './pi-provider.js';
import type { ModelMessage, ModelProvider, ModelTrace } from './types.js';

const textPartSchema = z.object({ type: z.literal('text'), text: z.string() });
const thinkingPartSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.array(z.unknown()),
});
const completionSchema = z.object({
  choices: z
    .tuple([
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          role: z.literal('assistant').nullish(),
          content: z
            .union([z.string(), z.array(z.looseObject({ type: z.string() }))])
            .nullish(),
          reasoning_content: z.string().nullish(),
          reasoning: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().nullish(),
                function: z.object({
                  name: z.string().min(1),
                  arguments: z.string(),
                }),
                extra_content: z
                  .object({
                    google: z
                      .object({ thought_signature: z.string().nullish() })
                      .nullish(),
                  })
                  .nullish(),
              }),
            )
            .nullish(),
        }),
      }),
    ])
    .rest(z.unknown()),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
      prompt_cache_hit_tokens: z.number().nullish(),
      prompt_cache_miss_tokens: z.number().nullish(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().nullish() })
        .nullish(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().nullish() })
        .nullish(),
    })
    .nullish(),
});

export type ProviderConfig =
  | { type: 'echo' }
  | {
      type: 'openai';
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      deepSeekReasoningEffort?: 'low' | 'high' | 'max';
    };

function wireMessages(messages: readonly ModelMessage[]) {
  return messages.flatMap((message): object[] => {
    switch (message.role) {
      case 'system':
        return [message];
      case 'user':
        return [
          {
            role: 'user',
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content.map((part) =>
                    part.type === 'text'
                      ? part
                      : {
                          type: 'image_url',
                          image_url: {
                            url: `data:${part.mediaType};base64,${typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64')}`,
                          },
                        },
                  ),
          },
        ];
      case 'assistant': {
        if (typeof message.content === 'string') return [message];
        const text = message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('');
        const reasoning = message.content
          .flatMap((part) => (part.type === 'reasoning' ? [part.text] : []))
          .join('');
        const calls = message.content.flatMap((part) => {
          if (part.type !== 'tool-call') return [];
          const signature = part.providerOptions?.google?.thoughtSignature;
          return [
            {
              type: 'function',
              id: part.toolCallId,
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
              ...(signature && {
                extra_content: { google: { thought_signature: signature } },
              }),
            },
          ];
        });
        return [
          {
            role: 'assistant',
            content: calls.length ? text || null : text,
            ...(reasoning && { reasoning_content: reasoning }),
            ...(calls.length && { tool_calls: calls }),
          },
        ];
      }
      case 'tool':
        return message.content.map((part) => ({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: part.output.value,
        }));
      default:
        throw new Error('Unsupported model message.');
    }
  });
}

type CompletionMessage = z.infer<
  typeof completionSchema
>['choices'][0]['message'];

function parseToolCall(
  call: NonNullable<CompletionMessage['tool_calls']>[number],
): ToolCall {
  const { name, arguments: input } = call.function;
  const id = call.id || `call_${randomUUID().replaceAll('-', '')}`;
  const thoughtSignature = call.extra_content?.google?.thought_signature;
  try {
    return {
      type: 'toolCall',
      id,
      name,
      arguments: parseToolArguments(JSON.parse(input)),
      ...(thoughtSignature && { thoughtSignature }),
    };
  } catch {
    return {
      type: 'toolCall',
      id,
      name,
      arguments: {},
      argumentsError: 'Expected a JSON object.',
    };
  }
}

function completionContent(
  message: CompletionMessage,
): AssistantMessage['content'] {
  const content: AssistantMessage['content'] = [];
  const reasoning = message.reasoning_content ?? message.reasoning;
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  const parts =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : (message.content ?? []);
  for (const part of parts) {
    const text = textPartSchema.safeParse(part);
    if (text.success && text.data.text) content.push(text.data);
    const thinking = thinkingPartSchema.safeParse(part);
    if (thinking.success) {
      const text = thinking.data.thinking
        .flatMap((chunk) => {
          const parsed = textPartSchema.safeParse(chunk);
          return parsed.success ? [parsed.data.text] : [];
        })
        .join('');
      if (text) content.push({ type: 'thinking', thinking: text });
    }
  }
  content.push(...(message.tool_calls ?? []).map(parseToolCall));
  return content;
}

export function createModelProvider(
  config: ProviderConfig,
  trace?: ModelTrace,
): ModelProvider {
  if (config.type === 'echo')
    return {
      async generate({ messages }) {
        const content =
          messages.findLast((message) => message.role === 'user')?.content ??
          '';
        const input =
          typeof content === 'string'
            ? content
            : content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n');
        const text = `收到：${input}`;
        return { text, messages: [{ role: 'assistant', content: text }] };
      },
    };

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const isDeepSeek = new URL(config.baseUrl).hostname === 'api.deepseek.com';
  return createPiModelProvider(
    config.model,
    async ({ messages, tools, hasTools }) => {
      let body: unknown;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(config.timeoutMs),
          body: JSON.stringify({
            model: config.model,
            messages: wireMessages(messages),
            ...(tools.length && {
              tools: tools.map(({ name, description, parameters }) => ({
                type: 'function',
                function: { name, description, parameters },
              })),
            }),
            ...(config.deepSeekReasoningEffort
              ? {
                  thinking: { type: 'enabled' },
                  reasoning_effort: config.deepSeekReasoningEffort,
                }
              : isDeepSeek && hasTools && { thinking: { type: 'disabled' } }),
          }),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new ModelHttpError(response.status);
        }
        body = await response.json();
      } catch (error) {
        if (error instanceof ModelHttpError) throw error;
        throw new Error('Model request failed.');
      }
      const parsed = completionSchema.safeParse(body);
      if (!parsed.success)
        throw new Error('Model returned an invalid response.');
      const {
        choices: [choice],
        usage,
      } = parsed.data;
      const hitTokens = usage?.prompt_cache_hit_tokens;
      const missTokens = usage?.prompt_cache_miss_tokens;
      const cacheRead =
        hitTokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const input =
        missTokens ?? Math.max(0, (usage?.prompt_tokens ?? 0) - cacheRead);
      const output = usage?.completion_tokens ?? 0;
      const reasoningTokens =
        usage?.completion_tokens_details?.reasoning_tokens;
      return {
        content: completionContent(choice.message),
        stopReason:
          choice.finish_reason === 'length'
            ? 'length'
            : choice.finish_reason === 'tool_calls' ||
                choice.finish_reason === 'function_call' ||
                choice.message.tool_calls?.length
              ? 'toolUse'
              : 'stop',
        ...(usage && {
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite: 0,
            totalTokens: usage.total_tokens ?? input + cacheRead + output,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
            ...(reasoningTokens != null && { reasoning: reasoningTokens }),
          },
        }),
        ...(hitTokens != null &&
          missTokens != null && { cache: { hitTokens, missTokens } }),
      };
    },
    trace,
  );
}

class ModelHttpError extends Error {
  constructor(status: number) {
    super(`Model request failed (HTTP ${status}).`);
  }
}
