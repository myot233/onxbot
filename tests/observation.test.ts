import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { traceIndexSchema } from '../apps/dashboard/src/contract.js';
import { createDashboardServer } from '../apps/dashboard/src/server.js';
import { TraceBuffer } from '../apps/dashboard/src/traces.js';
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
  const server = createDashboardServer(buffer, { password });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?session=group%2F42`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(
      url.replace('/?session=', '/api/traces?session='),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`onxbot:${password}`).toString('base64')}`,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const index = traceIndexSchema.parse(await response.json());
    expect(index.traces).toHaveLength(1);
    const detailResponse = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/traces/${group?.id}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`onxbot:${password}`).toString('base64')}`,
        },
      },
    );
    const html = await detailResponse.text();
    expect(html).toContain('prompt for group/42');
    expect(html).toContain('Group persona');
    expect(html).toContain('<script>alert(1)</script>');
    expect(detailResponse.headers.get('content-type')).toContain(
      'application/json',
    );
    expect(detailResponse.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(html).not.toContain('prompt for user/13');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('serves the dashboard and JSON without credentials by default and confines static assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-dashboard-'));
  const assets = join(root, 'client');
  await mkdir(join(assets, 'assets'), { recursive: true });
  await writeFile(
    join(assets, 'index.html'),
    '<html lang="zh-CN"><div id="root"></div></html>',
  );
  await writeFile(join(assets, 'assets/app.js'), 'console.log("dashboard")');
  await writeFile(join(root, 'private.js'), 'private server code');
  await symlink(join(root, 'private.js'), join(assets, 'assets/escape.js'));
  const server = createDashboardServer(new TraceBuffer(), {
    assetsDir: assets,
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(page.headers.get('www-authenticate')).toBeNull();
    expect(await page.text()).toContain('id="root"');
    const index = await fetch(`${base}/api/traces`);
    expect(traceIndexSchema.parse(await index.json()).traces).toEqual([]);
    const script = await fetch(`${base}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('cache-control')).toContain('immutable');
    for (const path of [
      '/assets/escape.js',
      '/assets/..%2f..%2fprivate.js',
      '/src/server.ts',
      '/api/traces/999',
    ]) {
      expect((await fetch(base + path)).status).toBe(404);
    }
    expect((await fetch(`${base}/api/traces`, { method: 'POST' })).status).toBe(
      405,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps bounded traces with explicit failure and truncation states', async () => {
  const buffer = new TraceBuffer();
  await expect(
    buffer.run('group/42', async () => {
      for (let i = 0; i < 18; i++)
        buffer.record({ phase: 'input', data: { text: 'x'.repeat(70_000) } });
      throw new Error('model failed');
    }),
  ).rejects.toThrow('model failed');
  expect(buffer.get(1)).toMatchObject({ status: '失败', truncated: true });
  expect(buffer.get(1)?.finishedAt).toBeDefined();
  expect(buffer.get(1)?.events).toHaveLength(16);
  for (let i = 0; i < 50; i++)
    await buffer.run('group/42', async () => {
      buffer.record({ phase: 'output', data: {} });
    });
  expect(buffer.list()).toHaveLength(50);
  expect(buffer.get(1)).toBeUndefined();
});
