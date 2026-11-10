import type { ConversationIdentity } from './conversation/types.js';
import type { MemoryScope } from './memory.js';

export const maxChatImages = 4;

export interface ChatImage {
  quoted: boolean;
  load(): Promise<
    { data: Uint8Array; mediaType: `image/${string}` } | undefined
  >;
}

export type ChatRequest =
  | {
      type: 'chat';
      identity: ConversationIdentity;
      text: string;
      images?: readonly ChatImage[];
      sentAt?: string;
      memoryScope?: MemoryScope;
    }
  | { type: 'reset'; identity: ConversationIdentity };

export interface ChatOptions {
  systemPrompt: string;
  historyTurns: number;
  maxInputChars: number;
}
