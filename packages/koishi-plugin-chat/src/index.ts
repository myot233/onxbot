import { createRequire } from 'node:module';
import {
  ChatInputError,
  type ChatRequest,
  type ChatService,
  type ConversationIdentity,
  type GroupChat,
} from '@onxbot/core';
import type { Context, Session } from 'koishi';

const { Argv, h } = createRequire(import.meta.url)(
  'koishi',
) as typeof import('koishi');

export const name = 'onxbot-chat';

export interface Config {
  service: ChatService;
  group?: { ids: readonly string[]; chat: GroupChat };
}

function identityFromSession(
  session: Session,
): ConversationIdentity | undefined {
  if (
    !session.platform ||
    !session.selfId ||
    !session.channelId ||
    !session.userId
  )
    return;
  return {
    platform: session.platform,
    botId: session.selfId,
    channelId: session.channelId,
    userId: session.userId,
  };
}

export function apply(context: Context, config: Config): void {
  const logger = context.logger(name);
  if (config.group) {
    const { chat, ids } = config.group;
    const enabledGroups = new Set(ids);
    context.on('message', async (session) => {
      if (
        session.isDirect ||
        session.userId === session.selfId ||
        !session.userId ||
        !session.guildId ||
        !enabledGroups.has(session.guildId)
      )
        return;

      const elements = session.elements ?? [];
      const mentions = elements.filter((element) => element.type === 'at');
      const quotedUser = session.quote?.user?.id;
      const direct =
        mentions.some(
          (element) => String(element.attrs.id) === session.selfId,
        ) || quotedUser === session.selfId;
      const text = plainText(elements);
      if (text.startsWith('/') || (!text && !direct)) return;
      const quote = plainText(session.quote?.elements ?? []);
      try {
        await chat.receive(
          {
            roomId: session.cid,
            speaker: session.username || session.userId,
            text: text || '（叫了你）',
            addressedTo: direct
              ? 'bot'
              : mentions.length || session.quote
                ? 'someone-else'
                : 'group',
            ...(quote && { quote }),
          },
          async (reply) => Boolean((await session.send(h.text(reply)))?.length),
        );
      } catch (error) {
        logger.warn(
          'Group chat failed: %s',
          error instanceof Error ? error.message : 'unknown error',
        );
      }
    });
  }
  context.before('parse', (content, session) => {
    const chat = /^chat(?:\s+([\s\S]*))?$/i.exec(content);
    if (session.stripped.prefix === null || !chat) return Argv.parse(content);
    return { name: 'chat', args: [h.unescape(chat[1] ?? '')], options: {} };
  });
  const execute = async (
    session: Session | undefined,
    request:
      | Omit<Extract<ChatRequest, { type: 'chat' }>, 'identity'>
      | { type: 'reset' },
  ) => {
    const identity = session && identityFromSession(session);
    if (!identity) return h.text('无法识别当前会话。');
    try {
      return h.text(await config.service.execute({ ...request, identity }));
    } catch (error) {
      if (error instanceof ChatInputError) return h.text(error.message);
      logger.warn(
        'Chat failed: %s',
        error instanceof Error ? error.message : 'unknown error',
      );
      return h.text('暂时无法完成对话，请稍后重试。');
    }
  };

  context
    .command('chat [text:text]', '与机器人对话')
    .action(({ session }, text) =>
      execute(session, { type: 'chat', text: text ?? '' }),
    );
  context
    .command('reset', '清空你在当前频道的对话上下文')
    .action(({ session }) => execute(session, { type: 'reset' }));
}

function plainText(elements: NonNullable<Session['elements']>): string {
  return elements
    .filter((element) => element.type === 'text')
    .map((element) => element.attrs.content)
    .join('')
    .trim();
}
