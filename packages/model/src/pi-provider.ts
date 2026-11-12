import { runAgentLoop } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  contentText,
  createAssistantMessageEventStream,
  createInitialSystemMessage,
  getCurrentTools,
  type Model,
  type Tool,
  toToolDeclaration,
} from '@earendil-works/pi-ai';
import {
  assistantMessage,
  fromPiAssistant,
  fromPiMessages,
  fromPiToolResult,
  toPiMessages,
} from './pi-messages.js';
import type {
  ModelMessage,
  ModelProvider,
  ModelTrace,
  TurnMessage,
} from './types.js';

interface ModelStepRequest {
  messages: readonly ModelMessage[];
  tools: readonly Tool[];
  hasTools: boolean;
}

interface ModelStepResult {
  content: AssistantMessage['content'];
  stopReason?: 'stop' | 'length' | 'toolUse';
  usage?: AssistantMessage['usage'];
  cache?: { hitTokens: number; missTokens: number };
}

export function createPiModelProvider(
  modelId: string,
  complete: (
    request: ModelStepRequest,
  ) => ModelStepResult | Promise<ModelStepResult>,
  trace?: ModelTrace,
): ModelProvider {
  // Request limits belong to the configured endpoint and ContextBuilder.
  const model: Model<string> = {
    id: modelId,
    name: modelId,
    api: 'onxbot-chat-completions',
    provider: 'onxbot',
    baseUrl: '',
    input: ['text', 'image'],
    reasoning: false,
    contextWindow: 0,
    maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  return {
    async generate({ messages, tools = [], maxSteps = 1, prepareMessages }) {
      if (!Number.isInteger(maxSteps) || maxSteps < 1)
        throw new Error('maxSteps must be a positive integer.');
      let step = 0;
      const output: TurnMessage[] = [];
      let text = '';
      let cache: ModelStepResult['cache'];
      let requestError: Error | undefined;

      await runAgentLoop(
        [],
        { messages: [] },
        {
          model,
          convertToLlm: (messages) => messages,
          prepareRequest() {
            step += 1;
            const prompt =
              step === 1
                ? messages
                : (prepareMessages?.(output) ?? [...messages, ...output]);
            const transcript = toPiMessages(prompt, model);
            const activeTools = step === maxSteps ? [] : [...tools];
            const declaration = createInitialSystemMessage(
              undefined,
              activeTools.map(toToolDeclaration),
            );
            if (declaration) {
              const first = transcript[0];
              if (first?.role === 'system')
                Object.assign(first, { toolsAdded: declaration.toolsAdded });
              else transcript.unshift(declaration);
            }
            return { context: { messages: transcript, tools: activeTools } };
          },
          finishTurn({ message, toolResults }) {
            if (
              message.stopReason === 'error' ||
              message.stopReason === 'aborted'
            )
              return;
            text = contentText(message.content, '').trim();
            const results = toolResults.map(fromPiToolResult);
            trace?.({
              phase: 'output',
              data: {
                finishReason:
                  message.stopReason === 'toolUse'
                    ? 'tool-calls'
                    : message.stopReason,
                usage: message.usage,
                cache,
                text,
                toolCalls: message.content.flatMap((part) =>
                  part.type === 'toolCall'
                    ? [
                        {
                          toolName: part.name,
                          toolCallId: part.id,
                          input: part.arguments,
                        },
                      ]
                    : [],
                ),
                toolResults: results.map(
                  ({ toolName, toolCallId, output }) => ({
                    toolName,
                    toolCallId,
                    output,
                  }),
                ),
              },
            });
            if (toolResults.some((result) => result.isError))
              throw new Error('Model tool execution failed.');
            output.push(fromPiAssistant(message));
            if (results.length) output.push({ role: 'tool', content: results });
          },
        },
        () => {},
        undefined,
        async (_, context) => {
          const stream = createAssistantMessageEventStream();
          try {
            const messages = fromPiMessages(context.messages);
            const activeTools = getCurrentTools(context.messages);
            if (trace) {
              trace({
                phase: 'input',
                data: {
                  modelId,
                  messages: messages.map(redactMessage),
                  tools: activeTools.map(({ name }) => name),
                },
              });
            }
            const result = await complete({
              messages,
              tools: activeTools,
              hasTools: tools.length > 0,
            });
            const { content, stopReason = 'stop', usage } = result;
            if (
              step === maxSteps &&
              (stopReason === 'toolUse' ||
                content.some((part) => part.type === 'toolCall'))
            )
              throw new Error('Model call limit reached.');
            cache = result.cache;
            const message = assistantMessage(model, content, stopReason, usage);
            stream.push({ type: 'done', reason: stopReason, message });
          } catch (error) {
            requestError =
              error instanceof Error
                ? error
                : new Error('Model request failed.');
            const message = assistantMessage(model, [], 'error');
            stream.push({ type: 'error', reason: 'error', error: message });
          }
          return stream;
        },
      );
      if (requestError !== undefined) throw requestError;
      return { text, messages: output };
    },
  };
}

function redactMessage(message: ModelMessage): unknown {
  if (
    (message.role !== 'user' && message.role !== 'assistant') ||
    typeof message.content === 'string'
  )
    return message;
  return {
    role: message.role,
    content: message.content.map((part) => {
      if (part.type === 'file')
        return { type: part.type, mediaType: part.mediaType, redacted: true };
      if (part.type === 'reasoning') return { type: part.type, redacted: true };
      if (part.type === 'tool-call') {
        const { providerOptions: _, ...call } = part;
        return call;
      }
      return part;
    }),
  };
}
