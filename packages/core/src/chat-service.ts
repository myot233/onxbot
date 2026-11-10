import { match } from 'ts-pattern';
import type { ContextBuilder } from './context/builder.js';
import type { ConversationService } from './conversation/service.js';
import { ChatInputError } from './errors.js';
import type { ConversationAgent } from './turn/agent.js';
import type { TurnRunner } from './turn/runner.js';
import { type ChatRequest, maxChatImages } from './types.js';

export class ChatService {
  constructor(
    private readonly modules: {
      conversations: ConversationService;
      context: ContextBuilder;
      runner: TurnRunner;
      agent?: ConversationAgent;
      maxInputChars: number;
    },
  ) {}

  async execute(request: ChatRequest): Promise<string> {
    return match(request)
      .with({ type: 'reset' }, async ({ identity }) => {
        await this.modules.conversations.reset(identity);
        return '已清空当前会话。';
      })
      .with(
        { type: 'chat' },
        async ({ identity, text, images, memoryScope, sentAt }) => {
          const input = text.trim();
          if (!input && !images?.length)
            throw new ChatInputError('请输入对话内容，例如：/chat 你好');
          if (input.length > this.modules.maxInputChars) {
            throw new ChatInputError(
              `消息过长，最多 ${this.modules.maxInputChars} 个字符。`,
            );
          }
          return this.modules.conversations.reply(
            {
              identity,
              input: images?.length
                ? [input, '[图片]'].filter(Boolean).join(' ')
                : input,
              sentAt,
              historyTurns: this.modules.context.historyTurns,
            },
            async (history) => {
              const context = await this.modules.context.build({
                identity,
                input,
                sentAt,
                history,
                images: images?.slice(0, maxChatImages),
              });
              return this.modules.agent && memoryScope
                ? this.modules.agent.run(context, memoryScope)
                : this.modules.runner.run(context);
            },
          );
        },
      )
      .exhaustive();
  }
}
