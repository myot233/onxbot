import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createTestDatabase } from './helpers/database.js';

it('exits cleanly on SIGTERM after receiving a OneBot message', async () => {
  const fixture = await createTestDatabase();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let notifyReply: (() => void) | undefined;
  const reply = new Promise<void>((resolve) => {
    notifyReply = resolve;
  });
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const data =
        message.action === 'get_login_info'
          ? { user_id: 10000, nickname: 'onxbot' }
          : message.action === 'get_guild_service_profile'
            ? { tiny_id: '0' }
            : { message_id: 1 };
      socket.send(
        JSON.stringify({ status: 'ok', retcode: 0, data, echo: message.echo }),
      );
      if (message.action === 'get_guild_service_profile') {
        socket.send(
          JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            self_id: 10000,
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            message_id: 1,
            user_id: 20000,
            sender: { user_id: 20000, nickname: 'Alice' },
            message: [{ type: 'text', data: { text: '/chat lifecycle' } }],
            raw_message: '/chat lifecycle',
          }),
        );
      }
      if (message.action === 'send_private_msg') notifyReply?.();
    });
  });
  let output = '';
  const child = spawn(
    process.execPath,
    ['--import=tsx', '--conditions=development', 'apps/bot/src/index.ts'],
    {
      env: {
        ...process.env,
        DATABASE_URL: fixture.connectionString,
        ONEBOT_SELF_ID: '10000',
        ONEBOT_TOKEN: 'test-token',
        ONEBOT_ENDPOINT: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        CHAT_PROVIDER: 'echo',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const closed = once(child, 'close');
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reply,
      new Promise((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error(`Bot did not reply: ${output}`)),
          8000,
        );
      }),
    ]);
    clearTimeout(startupTimer);
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2000) });
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    expect({ code, signal, errors: output.includes('TypeError') }).toEqual({
      code: 0,
      signal: null,
      errors: false,
    });
  } finally {
    clearTimeout(startupTimer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
});
