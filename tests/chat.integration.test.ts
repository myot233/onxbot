import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  type ChatProvider,
  ChatService,
  createChatProvider,
} from '../packages/core/src/index.js';
import {
  createConversationStore,
  migrate,
} from '../packages/database/src/index.js';
import { createTestDatabase } from './helpers/database.js';

describe('PostgreSQL 18 conversation persistence', () => {
  let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    fixture = await createTestDatabase();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const identity = (userId: string) => ({
    platform: 'onebot',
    botId: '10000',
    channelId: 'group:20000',
    userId,
  });
  const options = {
    systemPrompt: 'Be concise.',
    historyTurns: 1,
    maxInputChars: 100,
  };
  const requests: ChatMessage[][] = [];
  const provider: ChatProvider = {
    async complete(messages) {
      requests.push([...messages]);
      return `reply:${messages.at(-1)?.content}`;
    },
  };
  const service = () =>
    new ChatService(createConversationStore(fixture.db), provider, options);

  it('migrates idempotently and keeps context across service instances', async () => {
    await migrate(fixture.db);
    expect(
      await service().execute({
        type: 'chat',
        identity: identity('alice'),
        text: 'first',
      }),
    ).toBe('reply:first');
    await service().execute({
      type: 'chat',
      identity: identity('alice'),
      text: 'second',
    });
    expect(requests.at(-1)).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply:first' },
      { role: 'user', content: 'second' },
    ]);
    await service().execute({
      type: 'chat',
      identity: identity('alice'),
      text: 'third',
    });
    expect(requests.at(-1)?.map((message) => message.content)).toEqual([
      'Be concise.',
      'second',
      'reply:second',
      'third',
    ]);
    const row = await fixture.db
      .selectFrom('conversations')
      .select('id')
      .where('user_id', '=', 'alice')
      .executeTakeFirstOrThrow();
    expect(row.id[14]).toBe('7');
  });

  it('isolates users in a group and resets only the current conversation', async () => {
    const alice = identity('reset-alice');
    await service().execute({
      type: 'chat',
      identity: alice,
      text: 'before reset',
    });
    await service().execute({
      type: 'chat',
      identity: identity('bob'),
      text: 'private',
    });
    expect(requests.at(-1)?.map((message) => message.content)).toEqual([
      'Be concise.',
      'private',
    ]);
    await service().execute({ type: 'reset', identity: alice });
    await service().execute({
      type: 'chat',
      identity: alice,
      text: 'fresh',
    });
    expect(requests.at(-1)?.map((message) => message.content)).toEqual([
      'Be concise.',
      'fresh',
    ]);
    await service().execute({
      type: 'chat',
      identity: identity('bob'),
      text: 'again',
    });
    expect(requests.at(-1)?.map((message) => message.content)).toEqual([
      'Be concise.',
      'private',
      'reply:private',
      'again',
    ]);
  });

  it('does not persist a failed model turn', async () => {
    const alice = identity('failure-alice');
    await service().execute({ type: 'chat', identity: alice, text: 'fresh' });
    const failing = new ChatService(
      createConversationStore(fixture.db),
      {
        async complete() {
          throw new Error('model unavailable');
        },
      },
      options,
    );
    await expect(
      failing.execute({
        type: 'chat',
        identity: alice,
        text: 'failed',
      }),
    ).rejects.toThrow('model unavailable');
    await service().execute({
      type: 'chat',
      identity: alice,
      text: 'retry',
    });
    expect(requests.at(-1)?.map((message) => message.content)).toEqual([
      'Be concise.',
      'fresh',
      'reply:fresh',
      'retry',
    ]);
  });

  it.each([
    'http-error',
    'null-content',
    'empty-choices',
    'stalled-body',
  ] as const)('rolls back and recovers after provider %s', async (failure) => {
    let mode: 'seed' | 'fail' | 'recover' = 'seed';
    const payloads: Array<{ messages: ChatMessage[] }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      payloads.push(JSON.parse(body));
      response.setHeader('content-type', 'application/json');
      if (mode !== 'fail') {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: mode === 'seed' ? 'seed-reply' : 'recovered',
                },
              },
            ],
          }),
        );
      } else if (failure === 'http-error') {
        response.writeHead(503);
        response.end(JSON.stringify({ error: 'upstream unavailable' }));
      } else if (failure === 'null-content') {
        response.end(
          JSON.stringify({ choices: [{ message: { content: null } }] }),
        );
      } else if (failure === 'empty-choices') {
        response.end(JSON.stringify({ choices: [] }));
      } else {
        response.writeHead(200);
        response.flushHeaders();
        response.write('{"choices":');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const chat = new ChatService(
        createConversationStore(fixture.db),
        createChatProvider({
          type: 'openai',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          apiKey: 'test-key',
          model: 'test-model',
          timeoutMs: 500,
        }),
        options,
      );
      const who = identity(`provider-${failure}`);
      await chat.execute({ type: 'chat', identity: who, text: 'fresh' });
      mode = 'fail';
      await expect(
        chat.execute({ type: 'chat', identity: who, text: 'failed' }),
      ).rejects.toThrow();
      mode = 'recover';
      expect(
        await chat.execute({ type: 'chat', identity: who, text: 'retry' }),
      ).toBe('recovered');
      expect(payloads.at(-1)?.messages).toEqual([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'fresh' },
        { role: 'assistant', content: 'seed-reply' },
        { role: 'user', content: 'retry' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('serializes concurrent turns, including the first turn of a new conversation', async () => {
    const concurrentRequests: ChatMessage[][] = [];
    const concurrent = new ChatService(
      createConversationStore(fixture.db),
      {
        async complete(messages) {
          concurrentRequests.push([...messages]);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return `reply:${messages.at(-1)?.content}`;
        },
      },
      options,
    );
    await Promise.all(
      ['one', 'two'].map((text) =>
        concurrent.execute({
          type: 'chat',
          identity: identity('concurrent'),
          text,
        }),
      ),
    );
    expect(concurrentRequests.map((messages) => messages.length)).toEqual([
      2, 4,
    ]);
    const first = concurrentRequests[0]?.at(-1)?.content;
    expect(concurrentRequests[1]?.[1]?.content).toBe(first);
    expect(concurrentRequests[1]?.[2]?.content).toBe(`reply:${first}`);
  });
});
