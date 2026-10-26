import { createRequire } from 'node:module';
import { HTTP } from '@koishijs/plugin-http';
import type { ChatService } from '@onxbot/core';
import * as chatPlugin from '@onxbot/koishi-plugin-chat';
import type { Context as KoishiContext } from 'koishi';
import { OneBotBot } from 'koishi-plugin-adapter-onebot';
import type { BotConfig } from './config.js';

// Koishi 4's ESM loader imports a CommonJS default incorrectly; use its CJS entry.
const { Context } = createRequire(import.meta.url)(
  'koishi',
) as typeof import('koishi');

export function createBotRuntime(
  config: BotConfig,
  service: ChatService,
): { context: KoishiContext; stop(): Promise<void> } {
  const context = new Context({ prefix: ['/'], prefixMode: 'strict' });
  context.plugin(HTTP);
  const onebot = context.plugin<OneBotBot.Config>(OneBotBot, {
    ...config.onebot,
    retryTimes: 6,
    retryInterval: 5_000,
    retryLazy: 60_000,
  });
  context.plugin(chatPlugin, { service });
  return {
    context,
    async stop() {
      await Promise.all(context.bots.map((bot) => bot.stop()));
      onebot.dispose();
      await context.stop();
    },
  };
}
