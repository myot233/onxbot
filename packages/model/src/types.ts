import type { AgentTool } from '@earendil-works/pi-agent-core';

interface TextPart {
  type: 'text';
  text: string;
}

export type UserContent =
  | string
  | (
      | TextPart
      | { type: 'file'; mediaType: string; data: Uint8Array | string }
    )[];

type AssistantMessage = {
  role: 'assistant';
  content:
    | string
    | (
        | TextPart
        | { type: 'reasoning'; text: string }
        | {
            type: 'tool-call';
            toolName: string;
            toolCallId: string;
            input: unknown;
            providerOptions?: {
              google?: { thoughtSignature?: string };
              onxbot?: { thoughtSignature?: string };
            };
          }
      )[];
};

type ToolMessage = {
  role: 'tool';
  content: {
    type: 'tool-result';
    toolName: string;
    toolCallId: string;
    output: { type: 'text' | 'error-text'; value: string };
  }[];
};

export type TurnMessage = AssistantMessage | ToolMessage;
export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContent }
  | TurnMessage;
export type ConversationMessage = Exclude<ModelMessage, { role: 'system' }> & {
  sentAt?: string;
};

export type ModelTool = AgentTool;

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools?: readonly ModelTool[];
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
