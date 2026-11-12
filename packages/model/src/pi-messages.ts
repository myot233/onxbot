import {
  type AssistantMessage,
  contentText,
  type JsonObject,
  type Message,
  type Model,
  type ToolResultMessage,
  type Usage,
} from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { ModelMessage, TurnMessage } from './types.js';

const toolArgumentsSchema = z.record(z.string(), z.json());
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: zeroCost,
};

export function parseToolArguments(value: unknown): JsonObject {
  return toolArgumentsSchema.parse(value);
}

export function assistantMessage(
  model: Model<string>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  usage = zeroUsage,
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    usage,
    timestamp: Date.now(),
  };
}

export function toPiMessages(
  messages: readonly ModelMessage[],
  model: Model<string>,
): Message[] {
  return messages.flatMap((message): Message[] => {
    const timestamp = Date.now();
    switch (message.role) {
      case 'system':
        return [{ ...message, timestamp }];
      case 'user':
        return [
          {
            role: 'user',
            timestamp,
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content.map((part) =>
                    part.type === 'text'
                      ? part
                      : {
                          type: 'image',
                          mimeType: part.mediaType,
                          data:
                            typeof part.data === 'string'
                              ? part.data
                              : Buffer.from(part.data).toString('base64'),
                        },
                  ),
          },
        ];
      case 'assistant': {
        const content =
          typeof message.content === 'string'
            ? [{ type: 'text' as const, text: message.content }]
            : message.content.map(
                (part): AssistantMessage['content'][number] => {
                  switch (part.type) {
                    case 'text':
                      return part;
                    case 'reasoning':
                      return { type: 'thinking', thinking: part.text };
                    case 'tool-call': {
                      const thoughtSignature =
                        part.providerOptions?.onxbot?.thoughtSignature ??
                        part.providerOptions?.google?.thoughtSignature;
                      return {
                        type: 'toolCall',
                        id: part.toolCallId,
                        name: part.toolName,
                        arguments: parseToolArguments(part.input),
                        ...(thoughtSignature && { thoughtSignature }),
                      };
                    }
                    default:
                      throw new Error('Unsupported assistant content.');
                  }
                },
              );
        return [
          assistantMessage(
            model,
            content,
            content.some((part) => part.type === 'toolCall')
              ? 'toolUse'
              : 'stop',
          ),
        ];
      }
      case 'tool':
        return message.content.map(
          ({ toolName, toolCallId, output }): ToolResultMessage => ({
            role: 'toolResult',
            timestamp,
            toolCallId,
            toolName,
            content: [{ type: 'text', text: output.value }],
            isError: output.type === 'error-text',
          }),
        );
      default:
        throw new Error('Unsupported model message.');
    }
  });
}

export function fromPiAssistant(
  message: AssistantMessage,
): Extract<TurnMessage, { role: 'assistant' }> {
  const parts = message.content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if (part.type === 'thinking')
      return { type: 'reasoning' as const, text: part.thinking };
    return {
      type: 'tool-call' as const,
      toolName: part.name,
      toolCallId: part.id,
      input: part.arguments,
      ...(part.thoughtSignature && {
        providerOptions: {
          google: { thoughtSignature: part.thoughtSignature },
        },
      }),
    };
  });
  const single = parts.length === 1 ? parts[0] : undefined;
  return {
    role: 'assistant',
    content: single?.type === 'text' ? single.text : parts,
  };
}

export function fromPiToolResult({
  toolCallId,
  toolName,
  content,
  isError,
}: ToolResultMessage): Extract<
  TurnMessage,
  { role: 'tool' }
>['content'][number] {
  return {
    type: 'tool-result',
    toolCallId,
    toolName,
    output: {
      type: isError ? 'error-text' : 'text',
      value: contentText(content),
    },
  };
}

export function fromPiMessages(messages: readonly Message[]): ModelMessage[] {
  const output: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const content = contentText(message.content);
        if (content) output.push({ role: 'system', content });
        break;
      }
      case 'user':
        output.push({
          role: 'user',
          content:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) =>
                  part.type === 'text'
                    ? part
                    : {
                        type: 'file',
                        mediaType: part.mimeType,
                        data: part.data,
                      },
                ),
        });
        break;
      case 'assistant':
        output.push(fromPiAssistant(message));
        break;
      case 'toolResult': {
        const part = fromPiToolResult(message);
        const previous = output.at(-1);
        if (previous?.role === 'tool') previous.content.push(part);
        else output.push({ role: 'tool', content: [part] });
        break;
      }
    }
  }
  return output;
}
