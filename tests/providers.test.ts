import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    ).toMatchObject({ text: '收到：你好 <at id="123"/>' });
  });

  it('sends ordered context and authorization to an OpenAI-compatible endpoint', async () => {
    let payload: unknown;
    let authorization: string | undefined;
    const outputTraces: unknown[] = [];
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
          usage: {
            prompt_tokens: 130,
            completion_tokens: 2,
            total_tokens: 132,
            prompt_cache_hit_tokens: 128,
            prompt_cache_miss_tokens: 2,
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const provider = createModelProvider(
        {
          type: 'openai',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`,
          apiKey: 'test-key',
          model: 'test-model',
          timeoutMs: 1000,
        },
        ({ phase, data }) => {
          if (phase === 'output') outputTraces.push(data);
        },
      );
      const messages = [
        { role: 'system' as const, content: 'Be concise.' },
        { role: 'user' as const, content: '第一轮' },
        { role: 'assistant' as const, content: '上一轮回复' },
        { role: 'user' as const, content: '你好' },
      ];
      expect(await provider.generate({ messages })).toMatchObject({
        text: '你好！',
      });
      expect(authorization).toBe('Bearer test-key');
      expect(payload).toMatchObject({ model: 'test-model', messages });
      expect(outputTraces).toMatchObject([
        { cache: { hitTokens: 128, missTokens: 2 } },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

it('replays DeepSeek reasoning between tool steps and redacts it from observation', async () => {
  const requests: unknown[] = [];
  const traces: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const first = requests.length === 1;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: first ? 'tool_calls' : 'stop',
            message: first
              ? {
                  content: null,
                  reasoning_content: 'synthetic hidden reasoning',
                  tool_calls: [
                    {
                      id: 'probe-1',
                      type: 'function',
                      function: { name: 'probe', arguments: '{}' },
                    },
                  ],
                }
              : {
                  content: 'OK',
                  reasoning_content: 'synthetic final reasoning',
                },
          },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = createModelProvider(
      {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: 'test-key',
        model: 'deepseek-flash',
        timeoutMs: 1000,
        deepSeekReasoningEffort: 'high',
      },
      (event) => traces.push(event),
    );
    expect(
      await provider.generate({
        messages: [{ role: 'user', content: 'Run the probe.' }],
        maxSteps: 3,
        tools: {
          probe: tool({ inputSchema: z.object({}), execute: async () => 'ok' }),
        },
      }),
    ).toMatchObject({ text: 'OK' });
    expect(requests).toHaveLength(2);
    for (const payload of requests)
      expect(payload).toMatchObject({
        reasoning_effort: 'high',
        thinking: { type: 'enabled' },
      });
    expect(requests[1]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_content: 'synthetic hidden reasoning',
        }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'probe-1' }),
      ]),
    });
    expect(JSON.stringify(traces)).not.toContain('synthetic hidden reasoning');
    expect(JSON.stringify(traces)).toContain('redacted');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
