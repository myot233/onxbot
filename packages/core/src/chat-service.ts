import { takeRight } from 'lodash-es';
import { match } from 'ts-pattern';
import type {
  ChatMessage,
  ChatOptions,
  ChatProvider,
  ChatRequest,
  ConversationStore,
} from './types.js';

export class ChatInputError extends Error {}

export class ChatService {
  constructor(
    private readonly store: ConversationStore,
    private readonly provider: ChatProvider,
    private readonly options: ChatOptions,
  ) {}

  async execute(request: ChatRequest): Promise<string> {
    return match(request)
      .with({ type: 'reset' }, ({ identity }) =>
        this.store.withConversation(identity, async (conversation) => {
          await conversation.clear();
          return '已清空当前会话。';
        }),
      )
      .with({ type: 'chat' }, async ({ identity, text }) => {
        const input = text.trim();
        if (!input)
          throw new ChatInputError('请输入对话内容，例如：/chat 你好');
        if (input.length > this.options.maxInputChars) {
          throw new ChatInputError(
            `消息过长，最多 ${this.options.maxInputChars} 个字符。`,
          );
        }
        return this.store.withConversation(identity, async (conversation) => {
          const historyLimit = this.options.historyTurns * 2;
          const history =
            historyLimit === 0
              ? []
              : await conversation.getMessages(historyLimit);
          const messages: ChatMessage[] = [
            { role: 'system', content: this.options.systemPrompt },
            ...takeRight(history, historyLimit),
            { role: 'user', content: input },
          ];
          const reply = await this.provider.complete(messages);
          await conversation.appendTurn(input, reply);
          return reply;
        });
      })
      .exhaustive();
  }
}
