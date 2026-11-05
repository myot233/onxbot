import { createHash } from 'node:crypto';
import {
  ChatService,
  ContextBuilder,
  ConversationAgent,
  ConversationService,
  GroupChat,
  MarkdownMemory,
  TurnRunner,
} from '@onxbot/core';
import {
  createConversationStore,
  createDatabase,
  createGroupFeedback,
} from '@onxbot/database';
import { createModelProvider } from '@onxbot/model';
import { loadConfig } from './config.js';
import { createBotRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDatabase(config.databaseUrl);
  const model = createModelProvider(config.provider);
  const runner = new TurnRunner(model);
  const memory = new MarkdownMemory(config.memoryDir, (error) =>
    console.warn('Memory write failed:', error),
  );
  const agent =
    config.provider.type === 'echo'
      ? undefined
      : new ConversationAgent(runner, memory);
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
                'group-agent-v1',
                config.provider.model,
                config.groupSystemPrompt,
              ]),
            )
            .digest('hex')
            .slice(0, 16),
          config.onebot.token,
        )
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
  );
  const { context } = runtime;
  const logger = context.logger('onxbot');

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await runtime.stop();
      } finally {
        await Promise.all([db.destroy(), memory.close()]);
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
    await context.start();
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
