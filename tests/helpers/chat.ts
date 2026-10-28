import {
  type ChatOptions,
  ChatService,
  ContextBuilder,
  ConversationService,
  type ConversationStore,
  type Tool,
  TurnRunner,
} from '../../packages/core/src/index.js';
import type { ModelProvider } from '../../packages/model/src/index.js';

export function createChat(
  store: ConversationStore,
  model: ModelProvider,
  options: ChatOptions,
  tools: readonly Tool[] = [],
) {
  return new ChatService({
    conversations: new ConversationService(store),
    context: new ContextBuilder(options),
    runner: new TurnRunner(model, { tools }),
    maxInputChars: options.maxInputChars,
  });
}
