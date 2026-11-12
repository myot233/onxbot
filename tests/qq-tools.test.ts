import { expect, it, vi } from 'vitest';
import { createQqTools, type QqRequest } from '../apps/bot/src/qq-tools.js';
import { TurnRunner } from '../packages/core/src/index.js';
import { piModel, piResult } from './helpers/model.js';

it('binds QQ calls to the turn and rejects a quoted message from another group', async () => {
  const request = vi.fn<QqRequest>(async (action, params) => {
    if (action === 'get_group_msg_history')
      return {
        messages: [
          {
            sender: { nickname: 'A', user_id: '7' },
            time: Date.parse('2026-11-06T16:35:18Z') / 1000,
            message: [
              { type: 'text', data: { text: '周三读书会' } },
              {
                type: 'image',
                data: { url: 'https://example.org/private-media-url' },
              },
            ],
          },
        ],
      };
    if (action === 'get_msg')
      return {
        message_type: 'group',
        group_id: params.message_id === '98' ? '99' : '42',
      };
    if (action === 'get_forward_msg')
      return {
        messages: [
          {
            type: 'node',
            data: {
              nickname: 'B',
              message: [{ type: 'text', data: { text: '转发正文' } }],
            },
          },
        ],
      };
  });
  const tools = createQqTools(request, {
    groupId: '42',
    userId: '7',
    messageId: '-123',
    quoteId: '98',
  });
  let step = 0;
  const model = piModel(({ prompt }) => {
    const output = JSON.stringify(prompt.at(-1));
    const call = (toolName: string, input: object) =>
      piResult(
        [
          {
            type: 'tool-call',
            toolCallId: `qq-${step}`,
            toolName,
            input: JSON.stringify(input),
          },
        ],
        'tool-calls',
      );
    switch (step++) {
      case 0:
        return call('qq_group_history', { limit: 3, groupId: '99' });
      case 1:
        expect(output).toContain('周三读书会');
        expect(output).toContain('2026-11-07T00:35:18.000+08:00');
        expect(output).not.toContain('private-media-url');
        return call('qq_read_forward', { source: 'quote' });
      case 2:
        expect(output).toContain('unavailable data');
        return call('qq_read_forward', { source: 'message', messageId: '98' });
      case 3:
        expect(output).toContain('转发正文');
        return call('qq_react', { reaction: 'thumbs_up', messageId: '98' });
      case 4:
        return call('qq_poke', { userId: '999' });
      default:
        expect(output).toContain('already used a QQ interaction');
        return piResult([{ type: 'text', text: '查到了' }]);
    }
  });
  const runner = new TurnRunner(model, { tools });
  const result = await runner.run({
    messages: (output = []) => [
      { role: 'user', content: '看看转发说了什么' },
      ...output,
    ],
  });
  expect(result.reply).toBe('查到了');
  expect(request.mock.calls).toEqual([
    ['get_group_msg_history', { group_id: '42', count: 3 }],
    ['get_msg', { message_id: '98' }],
    ['get_msg', { message_id: '-123' }],
    ['get_forward_msg', { message_id: '-123' }],
    ['set_msg_emoji_like', { message_id: '-123', emoji_id: '76', set: true }],
  ]);

  expect(
    createQqTools(request, { groupId: '42' }).map(({ name }) => name),
  ).toEqual(['qq_group_history', 'qq_group_info', 'qq_group_files']);
});
