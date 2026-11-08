import { z } from 'zod';

const traceStatusSchema = z.enum(['运行中', '完成', '失败', '中断']);
const traceEventSchema = z.object({
  phase: z.enum(['input', 'output']),
  content: z.string(),
});
const traceSummarySchema = z.object({
  id: z.number().int().positive(),
  session: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: traceStatusSchema,
  truncated: z.boolean(),
  eventCount: z.number().int().nonnegative(),
});
export const traceSchema = traceSummarySchema
  .omit({ eventCount: true })
  .extend({
    events: z.array(traceEventSchema),
  });
export const traceQuerySchema = z.object({
  session: z.string().max(256).optional(),
  status: traceStatusSchema.optional(),
  search: z.string().max(256).optional(),
  before: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const tracePageSchema = z.object({
  limit: z.number(),
  nextCursor: z.number().optional(),
  traces: z.array(traceSummarySchema),
});
export type Trace = z.infer<typeof traceSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export type TraceQuery = z.infer<typeof traceQuerySchema>;
export interface TraceStore {
  start(session: string, owner: string): Promise<number>;
  append(
    id: number,
    sequence: number,
    event: TraceEvent,
    truncated: boolean,
  ): Promise<void>;
  finish(
    id: number,
    status: '完成' | '失败',
    truncated: boolean,
  ): Promise<void>;
  list(query: TraceQuery): Promise<z.infer<typeof tracePageSchema>>;
  get(id: number): Promise<Trace | undefined>;
  /** Renew active spans and mark expired spans interrupted. */
  maintain(owner: string, activeIds: readonly number[]): Promise<void>;
}
