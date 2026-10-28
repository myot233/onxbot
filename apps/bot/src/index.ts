import {
  ChatService,
  ContextBuilder,
  ConversationService,
  TurnRunner,
} from '@onxbot/core';
import { createConversationStore, createDatabase } from '@onxbot/database';
import { createModelProvider } from '@onxbot/model';
import { loadConfig } from './config.js';
import { createBotRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDatabase(config.databaseUrl);
  const service = new ChatService({
    conversations: new ConversationService(createConversationStore(db)),
    context: new ContextBuilder(config.chat),
    runner: new TurnRunner(createModelProvider(config.provider)),
    maxInputChars: config.chat.maxInputChars,
  });
  const runtime = createBotRuntime(config, service);
  const { context } = runtime;
  const logger = context.logger('onxbot');

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await runtime.stop();
      } finally {
        await db.destroy();
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
      .selectFrom('messages')
      .select(['id', 'tool_calls', 'tool_call_id'])
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
