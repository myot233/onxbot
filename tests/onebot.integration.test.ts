import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../apps/bot/src/config.js';
import { createBotRuntime } from '../apps/bot/src/runtime.js';
import { GroupChat } from '../packages/core/src/index.js';
import { createConversationStore } from '../packages/database/src/index.js';
import {
  createModelProvider,
  type ModelRequest,
} from '../packages/model/src/index.js';
import { createChat } from './helpers/chat.js';
import { createTestDatabase } from './helpers/database.js';

describe('headless Koishi with OneBot v11', () => {
  let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    fixture = await createTestDatabase();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it('handles private commands and group conversation over OneBot', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const connection = once(server, 'connection');
    const config = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      ONEBOT_SELF_ID: '10000',
      ONEBOT_TOKEN: 'test-token',
      CHAT_GROUP_IDS: '30000,30001',
      ONEBOT_ENDPOINT: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const groupCalls: ModelRequest[] = [];
    const runtime = createBotRuntime(
      config,
      createChat(
        createConversationStore(fixture.db),
        createModelProvider(config.provider),
        config.chat,
      ),
      new GroupChat(
        {
          async generate(request) {
            groupCalls.push(request);
            return {
              type: 'reply',
              text:
                request.messages.at(-1)?.content === '只是闲聊'
                  ? '[[SKIP]]'
                  : '我在，慢慢说。',
            };
          },
        },
        { systemPrompt: '简短、克制、讲证据。', spontaneous: true },
      ),
    );
    const { context } = runtime;
    const replies: Array<{
      user_id?: number;
      group_id?: number;
      message: unknown;
    }> = [];
    let notifyReply: (() => void) | undefined;
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        let data: unknown = {};
        if (message.action === 'get_login_info')
          data = { user_id: 10000, nickname: 'onxbot' };
        if (message.action === 'get_guild_service_profile')
          data = { tiny_id: '0' };
        if (message.action === 'get_msg')
          data = {
            time: Math.floor(Date.now() / 1000),
            message_id: message.params.message_id,
            message_type: 'group',
            group_id: 30000,
            sender: { user_id: 10000, nickname: 'onxbot' },
            message: [{ type: 'text', data: { text: '刚才说过的事' } }],
          };
        if (
          message.action === 'send_private_msg' ||
          message.action === 'send_group_msg'
        ) {
          replies.push(message.params);
          data = { message_id: replies.length };
        }
        socket.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data,
            echo: message.echo,
          }),
        );
        if (
          message.action === 'send_private_msg' ||
          message.action === 'send_group_msg'
        )
          notifyReply?.();
      });
    });
    try {
      const online = new Promise<void>((resolve) => {
        context.on('bot-status-updated', (bot) => {
          if (bot.isActive) resolve();
        });
      });
      await context.start();
      const [socket, request] = await connection;
      expect(request.headers.authorization).toBe('Bearer test-token');
      await online;
      const send = async (text: string, id: number) => {
        const sent = new Promise<void>((resolve) => {
          notifyReply = resolve;
        });
        socket.send(
          JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            self_id: 10000,
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            message_id: id,
            user_id: 20000,
            sender: { user_id: 20000, nickname: 'Alice' },
            message: [{ type: 'text', data: { text } }],
            raw_message: text,
          }),
        );
        await sent;
      };
      await send('/chat 你好 <at id="999"/>', 1);
      expect(replies[0]).toMatchObject({
        user_id: 20000,
        message: [
          { type: 'text', data: { text: '收到：你好 <at id="999"/>' } },
        ],
      });
      const rows = await fixture.db
        .selectFrom('messages')
        .selectAll()
        .orderBy('id')
        .execute();
      expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
      const literalBodies = [
        'explain $(reset)',
        '-1',
        '--help me',
        '- bullet point',
        '"keep quotes"\nnext line',
      ];
      for (const [index, body] of literalBodies.entries()) {
        await send(`/chat ${body}`, index + 2);
        expect(replies.at(-1)).toMatchObject({
          message: [{ type: 'text', data: { text: `收到：${body}` } }],
        });
      }
      const history = await fixture.db
        .selectFrom('messages')
        .select('content')
        .orderBy('id')
        .execute();
      expect(history.map((row) => row.content)).toEqual([
        '你好 <at id="999"/>',
        '收到：你好 <at id="999"/>',
        ...literalBodies.flatMap((body) => [body, `收到：${body}`]),
      ]);
      await send('/reset', 7);
      expect(
        await fixture.db.selectFrom('messages').selectAll().execute(),
      ).toEqual([]);
      await send('/chat', 8);
      expect(JSON.stringify(replies.at(-1)?.message)).toContain(
        '请输入对话内容',
      );

      let groupMessageId = 20;
      const sendGroup = (
        groupId: number,
        userId: number,
        text: string,
        prefix: unknown[] = [],
      ) => {
        socket.send(
          JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            self_id: 10000,
            post_type: 'message',
            message_type: 'group',
            sub_type: 'normal',
            message_id: groupMessageId++,
            group_id: groupId,
            user_id: userId,
            sender: {
              user_id: userId,
              nickname: userId === 20000 ? 'Alice' : 'Bob',
            },
            message: [...prefix, { type: 'text', data: { text } }],
            raw_message: text,
          }),
        );
      };
      const mention = [{ type: 'at', data: { qq: '10000' } }];
      sendGroup(30000, 20000, '在讨论浮点数');
      sendGroup(30000, 20001, '只是闲聊');
      sendGroup(30000, 20001, '冷却中');
      sendGroup(30002, 20000, '其他群', mention);
      sendGroup(30000, 10000, '自己的消息', mention);
      const mentionReply = new Promise<void>((resolve) => {
        notifyReply = resolve;
      });
      sendGroup(30000, 20000, '你怎么看？', mention);
      await mentionReply;
      expect(replies.at(-1)).toMatchObject({
        group_id: 30000,
        message: [{ type: 'text', data: { text: '我在，慢慢说。' } }],
      });
      expect(
        groupCalls.map(({ messages }) => messages.at(-1)?.content),
      ).toEqual(['只是闲聊', '你怎么看？']);
      const mentionedContext = JSON.stringify(groupCalls[1]?.messages);
      expect(mentionedContext).toContain('在讨论浮点数');
      expect(mentionedContext).toContain('Bob');
      expect(mentionedContext).toContain('简短、克制、讲证据');
      expect(mentionedContext).not.toContain('其他群');
      expect(mentionedContext).not.toContain('自己的消息');

      const quoteReply = new Promise<void>((resolve) => {
        notifyReply = resolve;
      });
      sendGroup(30000, 20001, '继续讲讲', [
        { type: 'reply', data: { id: '90' } },
      ]);
      await quoteReply;
      expect(groupCalls[2]?.messages.at(-2)?.content).toContain('刚才说过的事');

      const spontaneousReply = new Promise<void>((resolve) => {
        notifyReply = resolve;
      });
      sendGroup(30001, 20000, '另一群的消息');
      sendGroup(30001, 20001, '有人知道吗？');
      await spontaneousReply;
      expect(replies.at(-1)?.group_id).toBe(30001);
      expect(groupCalls[3]?.messages.at(-2)?.content).not.toContain('浮点数');
      expect(replies.filter((reply) => reply.group_id)).toHaveLength(3);
      expect(context.get('console')).toBeUndefined();
      expect(context.get('server')).toBeUndefined();
    } finally {
      await runtime.stop();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
