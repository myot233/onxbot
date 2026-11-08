import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  ChatService,
  ContextBuilder,
  ConversationAgent,
  ConversationService,
  GroupChat,
  MarkdownMemory,
  MemoryReview,
  TurnRunner,
} from '@onxbot/core';
import { createDashboardServer } from '@onxbot/dashboard';
import { TraceBuffer } from '@onxbot/dashboard/traces';
import {
  createConversationStore,
  createDatabase,
  createGroupFeedback,
  createGroupMemoryReviewStore,
  createGroupTopicStore,
} from '@onxbot/database';
import { createModelProvider } from '@onxbot/model';
import { loadConfig } from './config.js';
import { startMemoryReviewCron } from './memory-review-cron.js';
import { createBotRuntime } from './runtime.js';
import { createWebResearchTools } from './web-research.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDatabase(config.databaseUrl);
  const traces = config.observe ? new TraceBuffer() : undefined;
  const panel =
    traces &&
    config.observe &&
    createDashboardServer(traces, { password: config.observe.password });
  const model = createModelProvider(config.provider, traces?.record);
  const runner = new TurnRunner(model);
  const memory = new MarkdownMemory(config.memoryDir, (error) =>
    console.warn('Memory write failed:', error),
  );
  const agent =
    config.provider.type === 'echo'
      ? undefined
      : new ConversationAgent(
          runner,
          memory,
          config.webResearch
            ? createWebResearchTools(config.provider.apiKey)
            : undefined,
        );
  const service = new ChatService({
    conversations: new ConversationService(createConversationStore(db)),
    context: new ContextBuilder(config.chat),
    runner,
    ...(agent && { agent }),
    maxInputChars: config.chat.maxInputChars,
  });
  const feedback =
    config.feedbackGroupIds.length && config.provider.type === 'openai'
      ? createGroupFeedback(
          db,
          createHash('sha256')
            .update(
              JSON.stringify([
                'group-agent-v10',
                config.provider.model,
                config.webResearch,
                config.qqToolGroupIds,
                config.groupSystemPrompt,
              ]),
            )
            .digest('hex')
            .slice(0, 16),
          config.onebot.token,
        )
      : undefined;
  const topics =
    config.provider.type === 'openai' &&
    config.topicGroupIds.some((id) => config.groupIds.includes(id))
      ? createGroupTopicStore(db)
      : undefined;
  const reviewGroups = config.memoryReviewGroupIds.filter((id) =>
    config.groupIds.includes(id),
  );
  const reviewStore =
    config.provider.type === 'openai' && reviewGroups.length
      ? createGroupMemoryReviewStore(db)
      : undefined;
  const runtime = createBotRuntime(
    config,
    service,
    new GroupChat(model, {
      systemPrompt: config.groupSystemPrompt,
      spontaneous: config.provider.type !== 'echo',
      ...(agent && { agent }),
    }),
    feedback,
    traces?.run,
    topics,
    reviewStore,
  );
  const { context } = runtime;
  const logger = context.logger('onxbot');
  let stopMemoryReview: (() => Promise<void>) | undefined;

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await stopMemoryReview?.();
        await runtime.stop();
      } finally {
        await Promise.all([
          db.destroy(),
          memory.close(),
          panel &&
            new Promise<void>((resolve) => {
              panel.close(() => resolve());
            }),
        ]);
      }
    })());
  const onSignal = () => {
    // Satori reconnect timers can outlive a stopped adapter; exit after resources drain.
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await db
      .selectFrom('conversation_turns')
      .select(['id', 'messages'])
      .limit(0)
      .execute();
    if (topics)
      await db
        .selectFrom('group_topic_schedules')
        .select('next_run_at')
        .limit(0)
        .execute();
    if (panel && config.observe) {
      const listening = once(panel, 'listening');
      panel.listen(config.observe.port, config.observe.host);
      await listening;
      logger.info(
        'Observation panel listening on %s:%s',
        config.observe.host,
        config.observe.port,
      );
    }
    await context.start();
    if (reviewStore) {
      // Fail startup if the required migration has not been applied.
      await db
        .selectFrom('group_memory_schedules')
        .select('group_id')
        .limit(0)
        .execute();
      stopMemoryReview = startMemoryReviewCron({
        botId: config.onebot.selfId,
        groupIds: reviewGroups,
        store: reviewStore,
        review: new MemoryReview(
          new TurnRunner(model, { maxModelCalls: 24 }),
          memory,
          reviewStore,
        ),
        ...(traces && { observe: traces.run }),
      });
    }
    logger.info(
      'Started: OneBot %s, provider %s. Commands: /chat <text>, /reset',
      config.onebot.selfId,
      config.provider.type,
    );
    context.on('bot-status-updated', (bot) =>
      logger.info('OneBot %s: %s', bot.selfId, bot.status),
    );
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(
    'Bot startup failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
