import { z } from 'zod';

export const userMessageRoleSchema = z.object({ role: z.literal('user') });

export const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
});

export const replaceableAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([
    z.string(),
    z.array(
      z.object({ type: z.string().refine((type) => type !== 'tool-call') }),
    ),
  ]),
});
