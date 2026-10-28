import type { ModelProvider, TurnMessage } from '@onxbot/model';
import { match } from 'ts-pattern';
import type { PreparedContext } from '../context/builder.js';
import type { Tool } from './tools.js';

export interface TurnResult {
  reply: string;
  messages: readonly TurnMessage[];
}

export class TurnRunner {
  private readonly tools = new Map<string, Tool>();
  private readonly maxModelCalls: number;

  constructor(
    private readonly model: ModelProvider,
    options: { tools?: readonly Tool[]; maxModelCalls?: number } = {},
  ) {
    this.maxModelCalls = options.maxModelCalls ?? 8;
    if (!Number.isInteger(this.maxModelCalls) || this.maxModelCalls < 1)
      throw new Error('maxModelCalls must be a positive integer.');
    for (const tool of options.tools ?? []) {
      if (this.tools.has(tool.definition.name))
        throw new Error('Tool names must be unique.');
      this.tools.set(tool.definition.name, tool);
    }
  }

  async run(context: PreparedContext): Promise<TurnResult> {
    const messages: TurnMessage[] = [];
    for (let step = 0; step < this.maxModelCalls; step += 1) {
      const response = await this.model.generate({
        messages: context.messages(messages),
        ...(this.tools.size
          ? { tools: [...this.tools.values()].map((tool) => tool.definition) }
          : {}),
      });
      const reply = await match(response)
        .with({ type: 'reply' }, ({ text }) => {
          if (!text.trim()) throw new Error('Model returned an empty reply.');
          messages.push({ role: 'assistant', content: text });
          return text;
        })
        .with({ type: 'tool-calls' }, async ({ text, calls }) => {
          if (step + 1 === this.maxModelCalls)
            throw new Error('Model call limit reached.');
          if (!calls.length)
            throw new Error('Model returned an empty tool call list.');
          messages.push({ role: 'assistant', content: text, toolCalls: calls });
          for (const call of calls) {
            const tool = this.tools.get(call.name);
            if (!tool) throw new Error('Model requested an unavailable tool.');
            const output = await tool.execute(JSON.parse(call.arguments));
            messages.push({
              role: 'tool',
              content: output,
              toolCallId: call.id,
            });
          }
          return undefined;
        })
        .exhaustive();
      if (reply !== undefined) return { reply, messages };
    }
    throw new Error('Model call limit reached.');
  }
}
