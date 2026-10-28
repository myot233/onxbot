import type {
  ConversationMessage,
  ModelMessage,
  TurnMessage,
} from '@onxbot/model';
import { takeRight } from 'lodash-es';
import type { ConversationIdentity } from '../conversation/types.js';
import { ChatInputError } from '../errors.js';

export interface ContextRequest {
  identity: ConversationIdentity;
  input: string;
}

export interface ContextSource {
  name: string;
  load(request: ContextRequest): Promise<string | undefined>;
}

export interface ContextBudget {
  /** Input allowance, after reserving output and tool-definition tokens. */
  maxTokens: number;
  countTokens(messages: readonly ModelMessage[]): number;
}

export interface PreparedContext {
  /** Recalculate the window before every model request; never split a turn. */
  messages(output?: readonly TurnMessage[]): readonly ModelMessage[];
}

export class ContextLimitError extends ChatInputError {}

export class ContextBuilder {
  readonly historyTurns: number;

  constructor(
    private readonly options: {
      systemPrompt: string;
      historyTurns: number;
      sources?: readonly ContextSource[];
      budget?: ContextBudget;
    },
  ) {
    if (!Number.isInteger(options.historyTurns) || options.historyTurns < 0)
      throw new Error('historyTurns must be a nonnegative integer.');
    if (
      options.budget &&
      (!Number.isFinite(options.budget.maxTokens) ||
        options.budget.maxTokens <= 0)
    )
      throw new Error('maxTokens must be positive.');
    this.historyTurns = options.historyTurns;
  }

  async build(
    request: ContextRequest & { history: readonly ConversationMessage[] },
  ): Promise<PreparedContext> {
    const prefix: ModelMessage[] = [
      { role: 'system', content: this.options.systemPrompt },
    ];
    const sources = this.options.sources ?? [];
    const content = await Promise.all(
      sources.map((source) =>
        source.load({ identity: request.identity, input: request.input }),
      ),
    );
    for (const [index, text] of content.entries()) {
      if (text?.trim())
        prefix.push({
          role: 'user',
          content: `参考资料（${sources[index]?.name}）：\n${text}`,
        });
    }
    const turns: ConversationMessage[][] = [];
    for (const message of request.history) {
      if (message.role === 'user') turns.push([]);
      turns.at(-1)?.push(message);
    }
    const recent = takeRight(turns, this.historyTurns);
    const current: ModelMessage = { role: 'user', content: request.input };
    const budget = this.options.budget;
    return {
      messages(output = []) {
        for (let start = 0; start <= recent.length; start += 1) {
          const messages = [
            ...prefix,
            ...recent.slice(start).flat(),
            current,
            ...output,
          ];
          if (!budget || budget.countTokens(messages) <= budget.maxTokens)
            return messages;
        }
        throw new ContextLimitError(
          '当前输入或工具结果超过上下文预算，请缩短输入或工具结果。',
        );
      },
    };
  }
}
