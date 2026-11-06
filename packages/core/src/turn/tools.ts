import { type ToolSet, tool } from 'ai';
import type { z } from 'zod';

export interface Tool {
  name: string;
  implementation: ToolSet[string];
  lookup?: true;
}

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  input: Schema;
  lookup?: true;
  execute(input: z.output<Schema>): Promise<string>;
}): Tool {
  return {
    name: options.name,
    ...(options.lookup && { lookup: true }),
    implementation: tool({
      description: options.description,
      inputSchema: options.input,
      execute: options.execute,
      toModelOutput: ({ output }) => ({ type: 'text', value: output }),
    }),
  };
}
