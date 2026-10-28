export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: readonly ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  content: string;
  toolCallId: string;
}

export type TurnMessage = AssistantMessage | ToolMessage;
export type ConversationMessage =
  | { role: 'user'; content: string }
  | TurnMessage;
export type ModelMessage =
  | { role: 'system'; content: string }
  | ConversationMessage;

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools?: readonly ToolDefinition[];
}

export type ModelResponse =
  | { type: 'reply'; text: string }
  | { type: 'tool-calls'; text: string; calls: readonly ToolCall[] };

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
