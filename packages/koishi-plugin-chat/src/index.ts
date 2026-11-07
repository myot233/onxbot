import { createRequire } from 'node:module';
import {
  ChatInputError,
  type ChatRequest,
  type ChatService,
  type ConversationIdentity,
  feedbackLabels,
  type GroupChat,
  type GroupFeedback,
  type GroupLine,
  type GroupMemoryReviewStore,
  type GroupMessage,
  type GroupTopicStore,
  type MemoryScope,
  prepareGroupLine,
  type Tool,
} from '@onxbot/core';
import type { Context, Session } from 'koishi';

const { Argv, h } = createRequire(import.meta.url)(
  'koishi',
) as typeof import('koishi');

export const name = 'onxbot-chat';

export interface GroupToolTarget {
  groupId: string;
  userId?: string;
  messageId?: string;
  quoteId?: string;
}

export interface Config {
  service: ChatService;
  observe?: <T>(session: string, work: () => Promise<T>) => Promise<T>;
  group?: {
    ids: readonly string[];
    chat: GroupChat;
    topics?: { ids: readonly string[]; store: GroupTopicStore };
    memoryReview?: { ids: readonly string[]; store: GroupMemoryReviewStore };
    tools?: {
      ids: readonly string[];
      create(bot: Session['bot'], target: GroupToolTarget): readonly Tool[];
    };
  };
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
    const { chat, topics, tools, memoryReview } = config.group;
    const toolGroups = new Set(tools?.ids);
    const topicIds = topics?.ids.filter((id) => enabledGroups.has(id)) ?? [];
    const topicGroups = new Set(topicIds);
    const reviewGroups = new Set(memoryReview?.ids);
    const recordTopicLine = async (
      botId: string,
      groupId: string,
      line: GroupLine,
      human: boolean,
    ) => {
      try {
        if (topicGroups.has(groupId))
          await topics?.store.append(botId, groupId, line, human);
        if (reviewGroups.has(groupId))
          await memoryReview?.store.append(botId, groupId, line);
      } catch {
        logger.warn('Could not persist group background context.');
      }
    };
    if (topics && topicIds.length) {
      let stopped = false;
      let polling = false;
      const poll = async () => {
        if (stopped || polling) return;
        const bot = context.bots.find(
          (entry) => entry.platform === 'onebot' && entry.isActive,
        );
        if (!bot) return;
        polling = true;
        try {
          const due = await topics.store.claimDue(
            bot.selfId,
            topicIds.filter((id) => chat.canInitiateTopic(id)),
          );
          const results = await Promise.allSettled(
            due.map(async (topic) => {
              if (stopped || !bot.isActive) return;
              const run = () =>
                chat.initiateTopic(
                  topic.groupId,
                  topic.context,
                  async (reply) => {
                    if (
                      !(await topics.store.isCurrent(bot.selfId, topic)) ||
                      stopped ||
                      !bot.isActive
                    )
                      return false;
                    if (
                      !(await bot.sendMessage(topic.groupId, h.text(reply)))
                        ?.length
                    )
                      return false;
                    await recordTopicLine(
                      bot.selfId,
                      topic.groupId,
                      {
                        speaker: '你（onxbot）',
                        text: reply,
                        sentAt: new Date().toISOString(),
                      },
                      false,
                    );
                    return true;
                  },
                  tools && toolGroups.has(topic.groupId)
                    ? () => tools.create(bot, { groupId: topic.groupId })
                    : undefined,
                );
              if (config.observe)
                await config.observe(
                  `${bot.platform}/${bot.selfId}/group/${topic.groupId}`,
                  run,
                );
              else await run();
            }),
          );
          if (results.some((result) => result.status === 'rejected'))
            logger.warn('Scheduled group topic failed.');
        } catch {
          logger.warn('Could not claim scheduled group topics.');
        } finally {
          polling = false;
        }
      };
      const timer = setInterval(() => void poll(), 5_000).unref();
      context.on('dispose', () => {
        stopped = true;
        clearInterval(timer);
      });
    }
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
      const groupTools = toolGroups.has(guildId) ? tools : undefined;
      const forwarded =
        groupTools && elements.some((element) => element.type === 'forward');
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
      if (text.startsWith('/') || (!text && !direct && !forwarded)) return;
      const quoteElements = session.quote?.elements ?? [];
      const quote =
        plainText(quoteElements) ||
        (groupTools &&
        quoteElements.some((element) => element.type === 'forward')
          ? '[Forwarded QQ message]'
          : '');
      const messageId = session.messageId;
      const quoteId = session.quote?.messageId;
      const groupMessage: GroupMessage = {
        roomId: guildId,
        userId,
        speaker: session.username || userId,
        sentAt: new Date(
          Number.isFinite(session.timestamp) && session.timestamp > 0
            ? session.timestamp
            : Date.now(),
        ).toISOString(),
        text: text || (forwarded ? '[Forwarded QQ message]' : '（叫了你）'),
        addressedTo: direct
          ? 'bot'
          : mentions.length || session.quote
            ? 'someone-else'
            : 'group',
        ...(quote && { quote }),
      };
      const trackTopic = topicGroups.has(guildId);
      if (trackTopic || reviewGroups.has(guildId))
        await recordTopicLine(
          session.selfId,
          guildId,
          prepareGroupLine(groupMessage),
          true,
        );
      let replyId: string | undefined;
      try {
        const run = () =>
          chat.receive(
            groupMessage,
            async (reply, index) => {
              const [id] =
                (await session.send(
                  index === 0
                    ? [h.at(userId), h.text(` ${reply}`)]
                    : [h.text(reply)],
                )) ?? [];
              replyId ??= id;
              if (id && (trackTopic || reviewGroups.has(guildId)))
                await recordTopicLine(
                  session.selfId,
                  guildId,
                  {
                    speaker: '你（onxbot）',
                    text: reply,
                    sentAt: new Date().toISOString(),
                  },
                  false,
                );
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
            groupTools &&
              (() =>
                groupTools.create(session.bot, {
                  groupId: guildId,
                  userId,
                  ...(messageId && { messageId }),
                  ...(quoteId && { quoteId }),
                })),
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
          ? { kind: 'group', id: guildId, userId: identity.userId }
          : undefined;
    try {
      const run = () =>
        config.service.execute({
          ...request,
          identity,
          ...(request.type === 'chat' && scope && { memoryScope: scope }),
          ...(request.type === 'chat' && {
            sentAt: new Date(
              session &&
                Number.isFinite(session.timestamp) &&
                session.timestamp > 0
                ? session.timestamp
                : Date.now(),
            ).toISOString(),
          }),
        });
      const { platform, botId, channelId, userId } = identity;
      const reply =
        config.observe && request.type === 'chat'
          ? await config.observe(
              `${platform}/${botId}/chat/${channelId}/${userId}`,
              run,
            )
          : await run();
      const review = config.group?.memoryReview;
      if (
        request.type === 'chat' &&
        scope?.kind === 'group' &&
        review?.ids.includes(scope.id)
      ) {
        try {
          await review.store.append(
            identity.botId,
            scope.id,
            prepareGroupLine({
              roomId: scope.id,
              userId: identity.userId,
              speaker: session?.username || identity.userId,
              text: request.text,
              addressedTo: 'bot',
              sentAt: new Date(session?.timestamp || Date.now()).toISOString(),
            }),
          );
          await review.store.append(identity.botId, scope.id, {
            speaker: '你（onxbot）',
            text: reply.slice(0, 400),
            sentAt: new Date().toISOString(),
          });
        } catch {
          logger.warn('Could not persist command review context.');
        }
      }
      return h.text(reply);
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
