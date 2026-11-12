import type { ModelTool } from '@onxbot/model';
import { z } from 'zod';

export interface Tool extends ModelTool {
  lookup?: true;
}

export function defineTool<Schema extends z.ZodObject>(options: {
  name: string;
  description: string;
  input: Schema;
  lookup?: true;
  execute(input: z.output<Schema>): Promise<string>;
}): Tool {
  return {
    name: options.name,
    label: options.name,
    description: options.description,
    ...(options.lookup && { lookup: true }),
    parameters: z.toJSONSchema(options.input, {
      io: 'input',
      target: 'draft-7',
    }),
    // Check the raw arguments before Pi can coerce them.
    prepareArguments: (input) => options.input.parse(input),
    async execute(_id, input) {
      const text = await options.execute(options.input.parse(input));
      return { content: [{ type: 'text', text }], details: null };
    },
  };
}
