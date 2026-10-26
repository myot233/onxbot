export interface ConversationIdentity {
  platform: string;
  botId: string;
  channelId: string;
  userId: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatProvider {
  complete(messages: readonly ChatMessage[]): Promise<string>;
}

export interface ConversationTransaction {
  getMessages(limit: number): Promise<ChatMessage[]>;
  appendTurn(input: string, reply: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ConversationStore {
  withConversation<T>(
    identity: ConversationIdentity,
    work: (conversation: ConversationTransaction) => Promise<T>,
  ): Promise<T>;
}

export type ChatRequest =
  | { type: 'chat'; identity: ConversationIdentity; text: string }
  | { type: 'reset'; identity: ConversationIdentity };

export interface ChatOptions {
  systemPrompt: string;
  historyTurns: number;
  maxInputChars: number;
}
