import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createModelProvider } from '../packages/model/src/index.js';

describe('chat providers', () => {
  it('echo returns the latest user message', async () => {
    const provider = createModelProvider({ type: 'echo' });
    expect(
      await provider.generate({
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: '你好 <at id="123"/>' },
        ],
      }),
    ).toEqual({ type: 'reply', text: '收到：你好 <at id="123"/>' });
  });

  it('sends ordered context and authorization to an OpenAI-compatible endpoint', async () => {
    let payload: unknown;
    let authorization: string | undefined;
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization;
      let body = '';
      for await (const chunk of request) body += chunk;
      payload = JSON.parse(body);
      expect(request.url).toBe('/v1/chat/completions');
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '你好！', tool_calls: [] } }],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const provider = createModelProvider({
        type: 'openai',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`,
        apiKey: 'test-key',
        model: 'test-model',
        timeoutMs: 1000,
      });
      const messages = [
        { role: 'system' as const, content: 'Be concise.' },
        { role: 'user' as const, content: '第一轮' },
        { role: 'assistant' as const, content: '上一轮回复' },
        { role: 'user' as const, content: '你好' },
      ];
      expect(await provider.generate({ messages })).toEqual({
        type: 'reply',
        text: '你好！',
      });
      expect(authorization).toBe('Bearer test-key');
      expect(payload).toEqual({ model: 'test-model', messages, stream: false });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
