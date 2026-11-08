import { z } from 'zod';

export const traceSummarySchema = z.object({
  id: z.number().int().positive(),
  session: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(['运行中', '完成', '失败']),
  truncated: z.boolean(),
  eventCount: z.number().int().nonnegative(),
});
export const traceSchema = traceSummarySchema
  .omit({ eventCount: true })
  .extend({
    events: z.array(
      z.object({ phase: z.enum(['input', 'output']), content: z.string() }),
    ),
  });
export const traceIndexSchema = z.object({
  startedAt: z.string(),
  limit: z.number(),
  traces: z.array(traceSummarySchema),
});
export type Trace = z.infer<typeof traceSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;

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
