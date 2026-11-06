import {
  type ModelProvider,
  type ModelResponse,
  replaceableAssistantMessageSchema,
  type TurnMessage,
} from '@onxbot/model';
import type { PreparedContext } from '../context/builder.js';
import type { Tool } from './tools.js';

export interface TurnResult {
  reply: string;
  messages: readonly TurnMessage[];
}

export class TurnRunner {
  constructor(
    private readonly model: ModelProvider,
    private readonly options: {
      tools?: readonly Tool[];
      maxModelCalls?: number;
    } = {},
  ) {
    const limit = options.maxModelCalls ?? 8;
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('maxModelCalls must be a positive integer.');
    const names = (options.tools ?? []).map((entry) => entry.name);
    if (new Set(names).size !== names.length)
      throw new Error('Tool names must be unique.');
  }

  withTools(tools: readonly Tool[]): TurnRunner {
    return new TurnRunner(this.model, {
      ...this.options,
      tools: [...(this.options.tools ?? []), ...tools],
    });
  }

  async run(
    context: PreparedContext,
    selectReply?: (result: ModelResponse) => string | undefined,
  ): Promise<TurnResult> {
    const tools = this.options.tools;
    const result = await this.model.generate({
      messages: context.messages(),
      ...(tools?.length && {
        tools: Object.fromEntries(
          tools.map(({ name, implementation }) => [name, implementation]),
        ),
      }),
      maxSteps: this.options.maxModelCalls ?? 8,
      prepareMessages: (output) => context.messages(output),
    });
    const selected = selectReply?.(result);
    const reply = (selected ?? result.text).trim();
    if (!reply) {
      if (selected === '') return { reply, messages: result.messages };
      throw new Error('Model returned an empty reply.');
    }
    const messages = [...result.messages];
    if (replaceableAssistantMessageSchema.safeParse(messages.at(-1)).success)
      messages.pop();
    messages.push({ role: 'assistant', content: reply });
    return { reply, messages };
  }
}
