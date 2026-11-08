import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  memoryDocumentSchema,
  memoryIndexSchema,
} from '../apps/dashboard/src/contract.js';
import { createDashboardServer } from '../apps/dashboard/src/server.js';
import { MarkdownMemory } from '../packages/core/src/index.js';
import { memoryTraceStore } from './helpers/traces.js';

it('browses all supported scopes without exposing unrelated files, invalid names or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-browser-'));
  const memory = new MarkdownMemory(join(root, 'notes'), () => {});
  const expected = [
    'group/42/领域语言.md',
    'user/13/group/42/偏好.md',
    'user/13/个人记忆.md',
  ];
  try {
    expect(await memory.listDocuments()).toEqual([]);
    for (const path of [...expected, 'group/invalid/隐藏.md']) {
      await mkdir(join(root, 'notes', path.slice(0, path.lastIndexOf('/'))), {
        recursive: true,
      });
      await writeFile(join(root, 'notes', path), '# Document\n\nUseful facts');
    }
    await writeFile(join(root, 'private.md'), 'private data');
    await writeFile(join(root, 'notes/group/42/.env'), 'private config');
    await symlink(
      join(root, 'private.md'),
      join(root, 'notes/group/42/escape.md'),
    );
    await symlink(join(root, 'notes/user/13'), join(root, 'notes/group/43'));
    expect(await memory.listDocuments()).toEqual(expected);
    expect(await memory.readDocument(expected[0] ?? '')).toContain(
      'Useful facts',
    );
    for (const path of [
      '../private.md',
      'group/42/../../private.md',
      'group/invalid/隐藏.md',
      'group/42/.env',
      'group/42/missing.md',
    ])
      expect(await memory.readDocument(path)).toBeUndefined();
    await expect(memory.readDocument('group/42/escape.md')).rejects.toThrow();
    await expect(memory.readDocument('group/43/个人记忆.md')).rejects.toThrow();
    await writeFile(
      join(root, 'notes/group/42/oversized.md'),
      'x'.repeat(8193),
    );
    await expect(memory.readDocument('group/42/oversized.md')).rejects.toThrow(
      'size limit',
    );
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('serves read-only memory APIs with shared optional authentication and safe error responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onxbot-memory-api-'));
  const memory = new MarkdownMemory(root, () => {});
  await mkdir(join(root, 'group/42'), { recursive: true });
  const source = '# Example\n\n<script>alert(1)</script>\n';
  await writeFile(join(root, 'group/42/测试.md'), source);
  const server = createDashboardServer(memoryTraceStore(), { memory });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const index = await fetch(`${base}/api/memory`);
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(memoryIndexSchema.parse(await index.json()).paths).toEqual([
      'group/42/测试.md',
    ]);
    const detail = await fetch(
      base +
        '/api/memory/document?' +
        new URLSearchParams({ path: 'group/42/测试.md' }),
    );
    expect(detail.headers.get('content-type')).toContain('application/json');
    expect(memoryDocumentSchema.parse(await detail.json()).markdown).toBe(
      source,
    );
    expect((await fetch(`${base}/api/memory/document`)).status).toBe(400);
    expect(
      (await fetch(`${base}/api/memory/document?path=../private.md`)).status,
    ).toBe(404);
    expect((await fetch(`${base}/api/memory`, { method: 'POST' })).status).toBe(
      405,
    );
    memory.listDocuments = async () => {
      throw new Error('private filesystem path');
    };
    const failed = await fetch(`${base}/api/memory`);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const password = 'test-memory-browser-password';
  const protectedServer = createDashboardServer(memoryTraceStore(), {
    memory,
    password,
  });
  const ready = once(protectedServer, 'listening');
  protectedServer.listen(0, '127.0.0.1');
  await ready;
  const protectedBase = `http://127.0.0.1:${(protectedServer.address() as AddressInfo).port}`;
  try {
    expect((await fetch(`${protectedBase}/api/memory`)).status).toBe(401);
    expect(
      (
        await fetch(
          `${protectedBase}/api/memory/document?path=group%2F42%2F测试.md`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(
          protectedBase +
            '/api/memory/document?' +
            new URLSearchParams({ path: 'group/42/测试.md' }),
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`onxbot:${password}`).toString('base64')}`,
            },
          },
        )
      ).status,
    ).toBe(200);
  } finally {
    await new Promise<void>((resolve) =>
      protectedServer.close(() => resolve()),
    );
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
});
