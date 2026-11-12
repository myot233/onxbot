import type {
  ModelResponse,
  ModelTrace,
} from '../../packages/model/src/index.js';
import { parseToolArguments } from '../../packages/model/src/pi-messages.js';
import { createPiModelProvider } from '../../packages/model/src/pi-provider.js';

type Complete = Parameters<typeof createPiModelProvider>[1];
type Generated = Awaited<ReturnType<Complete>>;
type StepRequest = Parameters<Complete>[0];

export const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7p8AAAAASUVORK5CYII=',
  'base64',
);

export function piModel(
  generate: (request: {
    prompt: StepRequest['messages'];
    tools: StepRequest['tools'];
  }) => ReturnType<Complete>,
  trace?: ModelTrace,
) {
  return createPiModelProvider(
    'test-model',
    ({ messages, tools }) => generate({ prompt: messages, tools }),
    trace,
  );
}

export function piResult(
  content: (
    | { type: 'text'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  )[],
  reason: 'stop' | 'tool-calls' = 'stop',
): Generated {
  return {
    content: content.map((part) =>
      part.type === 'text'
        ? part
        : {
            type: 'toolCall',
            id: part.toolCallId,
            name: part.toolName,
            arguments: parseToolArguments(JSON.parse(part.input)),
          },
    ),
    stopReason: reason === 'tool-calls' ? 'toolUse' : 'stop',
  };
}

export function textReply(text: string): ModelResponse {
  return { text, messages: [{ role: 'assistant', content: text }] };
}
