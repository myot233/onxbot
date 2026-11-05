import { type ToolSet, tool } from 'ai';
import type { z } from 'zod';

export interface Tool {
  name: string;
  implementation: ToolSet[string];
}

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  input: Schema;
  execute(input: z.output<Schema>): Promise<string>;
}): Tool {
  return {
    name: options.name,
    implementation: tool({
      description: options.description,
      inputSchema: options.input,
      execute: options.execute,
      toModelOutput: ({ output }) => ({ type: 'text', value: output }),
    }),
  };
}
