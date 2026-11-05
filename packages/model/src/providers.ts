import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  generateText,
  isStepCount,
  type LanguageModel,
} from 'ai';
import type { ModelProvider, ModelTrace } from './types.js';

export type ProviderConfig =
  | { type: 'echo' }
  | {
      type: 'openai';
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    };

export function createSdkModelProvider(
  model: LanguageModel,
  options: { timeoutMs?: number; deepSeek?: boolean; trace?: ModelTrace } = {},
): ModelProvider {
  return {
    async generate({ messages, tools, maxSteps = 1, prepareMessages }) {
      try {
        const result = await generateText({
          model,
          messages: [...messages],
          allowSystemInMessages: true,
          maxRetries: 0,
          stopWhen: isStepCount(maxSteps),
          ...(options.trace && {
            onLanguageModelCallStart: ({
              modelId,
              messages,
              instructions,
              tools,
            }) => {
              options.trace?.({
                phase: 'input',
                data: {
                  modelId,
                  instructions,
                  messages,
                  tools: tools?.map(({ name }) => name),
                },
              });
            },
            onStepEnd: ({
              finishReason,
              usage,
              text,
              toolCalls,
              toolResults,
              providerMetadata,
            }) => {
              options.trace?.({
                phase: 'output',
                data: {
                  finishReason,
                  usage,
                  cache: providerMetadata?.deepseek,
                  text,
                  toolCalls: toolCalls.map(
                    ({ toolName, toolCallId, input }) => ({
                      toolName,
                      toolCallId,
                      input,
                    }),
                  ),
                  toolResults: toolResults.map(
                    ({ toolName, toolCallId, output }) => ({
                      toolName,
                      toolCallId,
                      output,
                    }),
                  ),
                },
              });
            },
          }),
          ...(tools && { tools }),
          ...(options.timeoutMs !== undefined && {
            timeout: { stepMs: options.timeoutMs },
          }),
          // DeepSeek thinking mode requires reasoning_content across tool steps.
          ...(options.deepSeek &&
            tools && {
              providerOptions: { onxbot: { thinking: { type: 'disabled' } } },
            }),
          prepareStep: ({ stepNumber, responseMessages, steps }) => {
            if (
              steps.at(-1)?.content.some((part) => part.type === 'tool-error')
            )
              throw new Error('Model tool execution failed.');
            return {
              ...(prepareMessages &&
                stepNumber > 0 && {
                  messages: [...prepareMessages(responseMessages)],
                }),
              ...(tools &&
                stepNumber === maxSteps - 1 && {
                  activeTools: [],
                  toolChoice: 'none',
                }),
            };
          },
        });
        if (
          result.finishReason === 'tool-calls' &&
          result.steps.length >= maxSteps
        )
          throw new Error('Model call limit reached.');
        if (result.content.some((part) => part.type === 'tool-error'))
          throw new Error('Model tool execution failed.');
        return { text: result.text.trim(), messages: result.responseMessages };
      } catch (error) {
        if (APICallError.isInstance(error))
          throw new Error(
            error.statusCode
              ? `Model request failed (HTTP ${error.statusCode}).`
              : 'Model request failed.',
          );
        throw error;
      }
    },
  };
}

export function createModelProvider(
  config: ProviderConfig,
  trace?: ModelTrace,
): ModelProvider {
  if (config.type === 'echo')
    return {
      async generate({ messages }) {
        const latest = messages.findLast((message) => message.role === 'user');
        const content = latest?.content;
        const text = `收到：${typeof content === 'string' ? content : ''}`;
        return { text, messages: [{ role: 'assistant', content: text }] };
      },
    };
  const provider = createOpenAICompatible({
    name: 'onxbot',
    apiKey: config.apiKey,
    baseURL: config.baseUrl.replace(/\/+$/, ''),
    metadataExtractor: {
      async extractMetadata({ parsedBody }) {
        if (
          !parsedBody ||
          typeof parsedBody !== 'object' ||
          !('usage' in parsedBody)
        )
          return;
        const usage = parsedBody.usage;
        if (!usage || typeof usage !== 'object') return;
        const hit =
          'prompt_cache_hit_tokens' in usage && usage.prompt_cache_hit_tokens;
        const miss =
          'prompt_cache_miss_tokens' in usage && usage.prompt_cache_miss_tokens;
        if (typeof hit === 'number' && typeof miss === 'number')
          return { deepseek: { hitTokens: hit, missTokens: miss } };
      },
      // The bot uses generateText, so no streaming metadata is collected.
      createStreamExtractor: () => ({
        processChunk() {},
        buildMetadata: () => undefined,
      }),
    },
  });
  return createSdkModelProvider(provider(config.model), {
    timeoutMs: config.timeoutMs,
    deepSeek: new URL(config.baseUrl).hostname === 'api.deepseek.com',
    ...(trace && { trace }),
  });
}
