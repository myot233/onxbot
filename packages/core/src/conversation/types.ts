import type { ConversationMessage, TurnMessage } from '@onxbot/model';

export interface ConversationIdentity {
  platform: string;
  botId: string;
  channelId: string;
  userId: string;
}

export interface ConversationSession {
  /** Read complete recent turns in chronological order. */
  getRecentTurns(limit: number): Promise<ConversationMessage[]>;
  appendTurn(input: string, output: readonly TurnMessage[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ConversationStore {
  /** Serialize work for this identity and commit it atomically on success. */
  withConversation<T>(
    identity: ConversationIdentity,
    work: (session: ConversationSession) => Promise<T>,
  ): Promise<T>;
}
