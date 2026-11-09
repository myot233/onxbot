import { MockLanguageModelV4 } from 'ai/test';
import {
  createSdkModelProvider,
  type ModelResponse,
} from '../../packages/model/src/index.js';

type Generate = MockLanguageModelV4['doGenerate'];
type Generated = Awaited<ReturnType<Generate>>;

export const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7p8AAAAASUVORK5CYII=',
  'base64',
);

export function sdkModel(
  generate: (
    options: Parameters<Generate>[0],
  ) => Generated | Promise<Generated>,
) {
  return createSdkModelProvider(
    new MockLanguageModelV4({
      doGenerate: async (options) => generate(options),
    }),
  );
}

export function sdkResult(
  content: Generated['content'],
  reason: 'stop' | 'tool-calls' = 'stop',
): Generated {
  return {
    content,
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
  };
}

export function textReply(text: string): ModelResponse {
  return { text, messages: [{ role: 'assistant', content: text }] };
}
