import { tracePageSchema } from '@onxbot/model';
import { z } from 'zod';

export type { Trace, TraceSummary } from '@onxbot/model';
export { traceSchema } from '@onxbot/model';
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
