import { match } from 'ts-pattern';
import type { ContextBuilder } from './context/builder.js';
import type { ConversationService } from './conversation/service.js';
import { ChatInputError } from './errors.js';
import type { TurnRunner } from './turn/runner.js';
import type { ChatRequest } from './types.js';

export class ChatService {
  constructor(
    private readonly modules: {
      conversations: ConversationService;
      context: ContextBuilder;
      runner: TurnRunner;
      maxInputChars: number;
    },
  ) {}

  async execute(request: ChatRequest): Promise<string> {
    return match(request)
      .with({ type: 'reset' }, async ({ identity }) => {
        await this.modules.conversations.reset(identity);
        return '已清空当前会话。';
      })
      .with({ type: 'chat' }, async ({ identity, text }) => {
        const input = text.trim();
        if (!input)
          throw new ChatInputError('请输入对话内容，例如：/chat 你好');
        if (input.length > this.modules.maxInputChars) {
          throw new ChatInputError(
            `消息过长，最多 ${this.modules.maxInputChars} 个字符。`,
          );
        }
        return this.modules.conversations.reply(
          { identity, input, historyTurns: this.modules.context.historyTurns },
          async (history) =>
            this.modules.runner.run(
              await this.modules.context.build({ identity, input, history }),
            ),
        );
      })
      .exhaustive();
  }
}
