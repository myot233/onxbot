import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createObservationPanel } from '../apps/bot/src/observe/panel.js';
import { TraceBuffer } from '../apps/bot/src/observe/traces.js';
import { defineTool, TurnRunner } from '../packages/core/src/index.js';
import { createSdkModelProvider } from '../packages/model/src/index.js';
import { sdkResult } from './helpers/model.js';

it('shows actual per-step tool context only on authenticated, session-filtered requests', async () => {
  const buffer = new TraceBuffer();
  const model = createSdkModelProvider(
    new MockLanguageModelV4({
      async doGenerate({ prompt }) {
        if (prompt.at(-1)?.role !== 'tool') {
          return sdkResult(
            [
              {
                type: 'tool-call',
                toolName: 'read_memory',
                toolCallId: 'read-1',
                input: '{}',
              },
            ],
            'tool-calls',
          );
        }
        return sdkResult([{ type: 'text', text: 'See you Tuesday.' }]);
      },
    }),
    { trace: buffer.record },
  );
  const runner = new TurnRunner(model, {
    tools: [
      defineTool({
        name: 'read_memory',
        description: 'Read a note',
        input: z.object({}),
        execute: async () => 'Tuesday <script>alert(1)</script>',
      }),
    ],
  });
  await Promise.all(
    ['group/42', 'user/13'].map((session) =>
      buffer.run(session, () =>
        runner.run({
          messages: (output = []) => [
            { role: 'system', content: 'Group persona' },
            { role: 'user', content: `prompt for ${session}` },
            ...output,
          ],
        }),
      ),
    ),
  );
  expect(buffer.list()).toHaveLength(2);
  const group = buffer.list().find((trace) => trace.session === 'group/42');
  expect(group?.events.map(({ phase }) => phase)).toEqual([
    'input',
    'output',
    'input',
    'output',
  ]);
  expect(group?.events[2]?.content).toContain(
    'Tuesday <script>alert(1)</script>',
  );
  expect(group?.events[2]?.content).not.toContain('prompt for user/13');

  const password = 'local-test-password-123456789';
  const server = createObservationPanel(buffer, password);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?session=group%2F42`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`onxbot:${password}`).toString('base64')}`,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('prompt for group/42');
    expect(html).toContain('Group persona');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('prompt for user/13');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
