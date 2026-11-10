import type { ModelMessage, ToolSet } from 'ai';

export type { ModelMessage } from 'ai';
export type UserContent = Extract<ModelMessage, { role: 'user' }>['content'];
export type TurnMessage = Extract<ModelMessage, { role: 'assistant' | 'tool' }>;
export type ConversationMessage = Exclude<ModelMessage, { role: 'system' }> & {
  sentAt?: string;
};

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
  prepareMessages?: (output: readonly TurnMessage[]) => readonly ModelMessage[];
}

export interface ModelResponse {
  text: string;
  messages: readonly TurnMessage[];
}

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelTrace = (event: {
  phase: 'input' | 'output';
  data: unknown;
}) => void;
