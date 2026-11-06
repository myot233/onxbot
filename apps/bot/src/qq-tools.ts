import { defineTool, type Tool } from '@onxbot/core';
import type { GroupToolTarget } from '@onxbot/koishi-plugin-chat';
import { z } from 'zod';

type QqAction =
  | 'get_group_msg_history'
  | 'get_group_info'
  | 'get_group_root_files'
  | 'get_msg'
  | 'get_forward_msg'
  | 'set_msg_emoji_like'
  | 'group_poke';

export type QqRequest = (
  action: QqAction,
  params: Record<string, string | number | boolean>,
) => Promise<unknown>;

const messageIdSchema = z.string().regex(/^-?\d{1,20}$/);
const groupIdSchema = z.string().regex(/^\d{1,20}$/);
const reactionIds = {
  smile: '14',
  heart: '66',
  thumbs_up: '76',
  side_eye: '178',
  facepalm: '264',
} as const;
const rawIdSchema = z.union([z.string(), z.number()]).transform(String);
const envelopeSchema = z.object({ messages: z.array(z.unknown()) });
const rawGroupMessageSchema = z.object({
  message_type: z.literal('group'),
  group_id: rawIdSchema,
});
const segmentSchema = z.object({
  type: z.string(),
  data: z.object({ text: z.string().optional() }).optional(),
});
const messageSchema = z.object({
  sender: z
    .object({ nickname: z.string().optional(), card: z.string().optional() })
    .optional(),
  message: z.unknown(),
  time: z
    .number()
    .int()
    .positive()
    .max(253_402_300_799)
    .optional()
    .catch(undefined),
});
const forwardNodeSchema = z.object({
  type: z.literal('node'),
  data: z.object({
    nickname: z.string().optional(),
    message: z.unknown().optional(),
    content: z.unknown().optional(),
  }),
});
const groupSchema = z.object({
  group_name: z.string(),
  member_count: z.number().optional(),
  max_member_count: z.number().optional(),
});
const filesSchema = z.object({
  files: z
    .array(
      z.object({
        file_name: z.string(),
        file_size: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .default([]),
  folders: z.array(z.object({ folder_name: z.string() })).default([]),
});

function summarizeSegments(content: unknown): string {
  if (typeof content === 'string')
    return content.replace(/\[CQ:[^\]]*\]/g, '[attachment]').slice(0, 400);
  const parsed = z.array(z.unknown()).safeParse(content);
  if (!parsed.success) return '';
  return parsed.data
    .slice(0, 12)
    .map((raw) => {
      const segment = segmentSchema.safeParse(raw);
      if (!segment.success) return '';
      const { type, data } = segment.data;
      if (type === 'text') return data?.text?.slice(0, 400) ?? '';
      return type === 'forward' ? '[forwarded messages]' : '[attachment]';
    })
    .join('')
    .slice(0, 400);
}

function summarizeMessages(messages: unknown[], limit: number) {
  return messages.slice(0, limit).flatMap((message) => {
    const node = forwardNodeSchema.safeParse(message);
    if (node.success) {
      const { nickname, message: body, content } = node.data.data;
      return [
        {
          speaker: nickname?.slice(0, 60),
          text: summarizeSegments(body) || summarizeSegments(content),
        },
      ];
    }
    const normal = messageSchema.safeParse(message);
    if (!normal.success) return [];
    const { sender, message: body, time } = normal.data;
    return [
      {
        speaker: (sender?.card || sender?.nickname)?.slice(0, 60),
        text: summarizeSegments(body),
        ...(time && { sentAt: new Date(time * 1_000).toISOString() }),
      },
    ];
  });
}

export function createQqTools(
  request: QqRequest,
  target: GroupToolTarget,
): readonly Tool[] {
  const group = groupIdSchema.safeParse(target.groupId);
  if (!group.success) return [];
  const group_id = group.data;
  const user_id = groupIdSchema.safeParse(target.userId).data;
  const message_id = messageIdSchema.safeParse(target.messageId).data;
  const quoteId = messageIdSchema.safeParse(target.quoteId).data;
  let readsLeft = 3;
  let interacted = false;

  async function read(work: () => Promise<unknown>): Promise<string> {
    if (!readsLeft) return 'The QQ lookup budget for this turn is exhausted.';
    readsLeft -= 1;
    try {
      return JSON.stringify(await work());
    } catch {
      return 'QQ lookup failed or returned unavailable data.';
    }
  }

  async function interact(
    action: 'set_msg_emoji_like' | 'group_poke',
    params: Record<string, string | boolean>,
  ): Promise<string> {
    if (interacted) return 'This turn already used a QQ interaction.';
    interacted = true;
    try {
      await request(action, params);
      return 'QQ interaction completed.';
    } catch {
      return 'QQ interaction failed.';
    }
  }

  return [
    defineTool({
      name: 'qq_group_history',
      lookup: true,
      description:
        'Read recent text in the current QQ group. You MUST use it only when relevant earlier context is missing.',
      input: z.object({ limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ limit = 10 }) =>
        read(async () => {
          const data = envelopeSchema.parse(
            await request('get_group_msg_history', { group_id, count: limit }),
          );
          return summarizeMessages(data.messages, limit);
        }),
    }),
    defineTool({
      name: 'qq_group_info',
      lookup: true,
      description: 'Read the current QQ group name and member counts.',
      input: z.object({}),
      execute: async () =>
        read(async () =>
          groupSchema.parse(await request('get_group_info', { group_id })),
        ),
    }),
    defineTool({
      name: 'qq_group_files',
      lookup: true,
      description:
        'List the names and sizes of files and folder names at the root of the current QQ group.',
      input: z.object({}),
      execute: async () =>
        read(async () => {
          const { files, folders } = filesSchema.parse(
            await request('get_group_root_files', { group_id }),
          );
          return {
            files: files.slice(0, 12).map(({ file_name, file_size }) => ({
              file_name: file_name.slice(0, 160),
              file_size,
            })),
            folders: folders
              .slice(0, 12)
              .map(({ folder_name }) => folder_name.slice(0, 160)),
          };
        }),
    }),
    ...(message_id || quoteId
      ? [
          defineTool({
            name: 'qq_read_forward',
            lookup: true,
            description:
              'Read a merged forward attached to the triggering QQ message or to its quoted message.',
            input: z.object({
              source: z.enum(['message', 'quote']).optional(),
            }),
            execute: async ({ source = 'message' }) => {
              const id = source === 'quote' ? quoteId : message_id;
              if (!id) return 'That message is unavailable in this turn.';
              return read(async () => {
                const message = rawGroupMessageSchema.parse(
                  await request('get_msg', { message_id: id }),
                );
                if (message.group_id !== group_id)
                  throw new Error('Message is outside this group.');
                const data = envelopeSchema.parse(
                  await request('get_forward_msg', { message_id: id }),
                );
                return summarizeMessages(data.messages, 12);
              });
            },
          }),
        ]
      : []),
    ...(message_id
      ? [
          defineTool({
            name: 'qq_react',
            description:
              'Add one native QQ emoji reaction to the triggering message. You MUST prefer this tool for a lightweight acknowledgement when the reaction conveys the whole response.',
            input: z.object({
              reaction: z.enum(
                Object.keys(reactionIds) as (keyof typeof reactionIds)[],
              ),
            }),
            execute: async ({ reaction }) =>
              interact('set_msg_emoji_like', {
                message_id,
                emoji_id: reactionIds[reaction],
                set: true,
              }),
          }),
        ]
      : []),
    ...(user_id
      ? [
          defineTool({
            name: 'qq_poke',
            description:
              'Send one QQ poke to the triggering member. You MUST use it only when they explicitly ask for a poke or directly invite a playful interaction with the bot.',
            input: z.object({}),
            execute: async () => interact('group_poke', { group_id, user_id }),
          }),
        ]
      : []),
  ];
}
