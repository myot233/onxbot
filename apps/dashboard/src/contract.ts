import { tracePageSchema } from '@onxbot/model/trace';
import { z } from 'zod';

export const memoryIndexSchema = z.object({ paths: z.array(z.string()) });
export const memoryDocumentSchema = z.object({
  path: z.string(),
  markdown: z.string(),
});
export interface MemoryDocuments {
  listDocuments(): Promise<string[]>;
  readDocument(path: string): Promise<string | undefined>;
}

export type { Trace, TraceSummary } from '@onxbot/model/trace';
export { traceSchema } from '@onxbot/model/trace';
export const traceIndexSchema = tracePageSchema.extend({
  startedAt: z.string(),
});

export const modelInputSchema = z.object({
  modelId: z.string().optional(),
  instructions: z.unknown().optional(),
  messages: z
    .array(z.object({ role: z.string(), content: z.unknown() }))
    .default([]),
  tools: z.array(z.string()).default([]),
});
export const modelOutputSchema = z.object({
  text: z.string().default(''),
  toolCalls: z
    .array(
      z.object({
        toolName: z.string(),
        toolCallId: z.string(),
        input: z.unknown(),
      }),
    )
    .default([]),
  toolResults: z
    .array(
      z.object({
        toolName: z.string(),
        toolCallId: z.string(),
        output: z.unknown(),
      }),
    )
    .default([]),
});
