import type { ConversationIdentity } from './conversation/types.js';
import type { MemoryScope } from './memory.js';

export type ChatRequest =
  | {
      type: 'chat';
      identity: ConversationIdentity;
      text: string;
      memoryScope?: MemoryScope;
    }
  | { type: 'reset'; identity: ConversationIdentity };

export interface ChatOptions {
  systemPrompt: string;
  historyTurns: number;
  maxInputChars: number;
}
