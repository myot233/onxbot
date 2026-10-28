import type { ToolDefinition } from '@onxbot/model';
import { z } from 'zod';

export interface Tool {
  definition: ToolDefinition;
  execute(input: unknown): Promise<string>;
}

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  input: Schema;
  execute(input: z.output<Schema>): Promise<string>;
}): Tool {
  return {
    definition: {
      name: options.name,
      description: options.description,
      parameters: z.toJSONSchema(options.input, {
        target: 'draft-7',
        io: 'input',
      }),
    },
    async execute(input) {
      return options.execute(await options.input.parseAsync(input));
    },
  };
}
