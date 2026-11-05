import { createRequire } from 'node:module';
import {
  ChatInputError,
  type ChatRequest,
  type ChatService,
  type ConversationIdentity,
  feedbackLabels,
  type GroupChat,
  type GroupFeedback,
  type MemoryScope,
} from '@onxbot/core';
import type { Context, Session } from 'koishi';

const { Argv, h } = createRequire(import.meta.url)(
  'koishi',
) as typeof import('koishi');

export const name = 'onxbot-chat';

export interface Config {
  service: ChatService;
  observe?: <T>(session: string, work: () => Promise<T>) => Promise<T>;
  group?: { ids: readonly string[]; chat: GroupChat };
  feedback?: { ids: readonly string[]; store: GroupFeedback };
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
  const enabledGroups = new Set(config.group?.ids);
  const feedbackGroups = new Set(config.feedback?.ids);
  if (config.group) {
    const { chat } = config.group;
    context.on('message', async (session) => {
      const { userId, guildId } = session;
      if (
        session.isDirect ||
        userId === session.selfId ||
        !userId ||
        !guildId ||
        !enabledGroups.has(guildId)
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
      const feedback = feedbackGroups.has(guildId)
        ? config.feedback?.store
        : undefined;
      const vote = /^\/bot-feedback\s+(\w+)$/i.exec(text)?.[1]?.toLowerCase();
      const label = feedbackLabels.find((entry) => entry === vote);
      if (feedback && label) {
        try {
          const quoteId = session.quote?.messageId;
          const saved =
            quotedUser === session.selfId &&
            quoteId &&
            (await feedback.rate(guildId, quoteId, userId, label));
          await session.send(
            h.text(
              saved ? '已记录反馈。' : '请引用本群一条已采样的 Bot 回复。',
            ),
          );
        } catch {
          logger.warn('Could not record group feedback.');
        }
        return;
      }
      if (text.startsWith('/') || (!text && !direct)) return;
      const quote = plainText(session.quote?.elements ?? []);
      const messageId = session.messageId;
      let replyId: string | undefined;
      try {
        const run = () =>
          chat.receive(
            {
              roomId: guildId,
              speaker: session.username || userId,
              text: text || '（叫了你）',
              addressedTo: direct
                ? 'bot'
                : mentions.length || session.quote
                  ? 'someone-else'
                  : 'group',
              ...(quote && { quote }),
            },
            async (reply, index) => {
              const [id] =
                (await session.send(
                  index === 0
                    ? [h.at(userId), h.text(` ${reply}`)]
                    : [h.text(reply)],
                )) ?? [];
              replyId ??= id;
              return Boolean(id);
            },
            feedback && messageId
              ? (decision) => {
                  void feedback
                    .record({
                      ...decision,
                      groupId: guildId,
                      messageId,
                      ...(replyId && { replyId }),
                    })
                    .catch(() =>
                      logger.warn('Could not record group decision.'),
                    );
                }
              : undefined,
          );
        if (config.observe)
          await config.observe(
            `${session.platform}/${session.selfId}/group/${guildId}`,
            run,
          );
        else await run();
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
    const guildId = session?.guildId;
    const scope: MemoryScope | undefined =
      session?.isDirect && /^\d{1,32}$/.test(identity.userId)
        ? { kind: 'user', id: identity.userId }
        : guildId && enabledGroups.has(guildId)
          ? { kind: 'group', id: guildId }
          : undefined;
    try {
      const run = () =>
        config.service.execute({
          ...request,
          identity,
          ...(request.type === 'chat' && scope && { memoryScope: scope }),
        });
      const { platform, botId, channelId, userId } = identity;
      return h.text(
        config.observe && request.type === 'chat'
          ? await config.observe(
              `${platform}/${botId}/chat/${channelId}/${userId}`,
              run,
            )
          : await run(),
      );
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
