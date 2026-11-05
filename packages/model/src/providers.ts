import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  generateText,
  isStepCount,
  type LanguageModel,
} from 'ai';
import type { ModelProvider } from './types.js';

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
  options: { timeoutMs?: number; deepSeek?: boolean } = {},
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

export function createModelProvider(config: ProviderConfig): ModelProvider {
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
  });
  return createSdkModelProvider(provider(config.model), {
    timeoutMs: config.timeoutMs,
    deepSeek: new URL(config.baseUrl).hostname === 'api.deepseek.com',
  });
}
