import type { ConversationMessage } from '@onxbot/model';
import type { TurnResult } from '../turn/runner.js';
import type { ConversationIdentity, ConversationStore } from './types.js';

export class ConversationService {
  constructor(private readonly store: ConversationStore) {}

  async reply(
    request: {
      identity: ConversationIdentity;
      input: string;
      historyTurns: number;
    },
    generate: (history: readonly ConversationMessage[]) => Promise<TurnResult>,
  ): Promise<string> {
    return this.store.withConversation(request.identity, async (session) => {
      const history =
        request.historyTurns === 0
          ? []
          : await session.getRecentTurns(request.historyTurns);
      const result = await generate(history);
      await session.appendTurn(request.input, result.messages);
      return result.reply;
    });
  }

  async reset(identity: ConversationIdentity): Promise<void> {
    await this.store.withConversation(identity, (session) => session.clear());
  }
}
