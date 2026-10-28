import type { ConversationIdentity } from './conversation/types.js';

export type ChatRequest =
  | { type: 'chat'; identity: ConversationIdentity; text: string }
  | { type: 'reset'; identity: ConversationIdentity };

export interface ChatOptions {
  systemPrompt: string;
  historyTurns: number;
  maxInputChars: number;
}
