import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/bot/src/config.js';

const required = {
  DATABASE_URL: 'postgresql://localhost/onxbot',
  ONEBOT_SELF_ID: '10000',
  ONEBOT_ENDPOINT: 'ws://127.0.0.1:3001',
  ONEBOT_TOKEN: 'test-token',
};

describe('configuration', () => {
  it('defaults to echo and validates numeric settings', () => {
    const config = loadConfig(required);
    expect(config.provider).toEqual({ type: 'echo' });
    expect(config.chat.historyTurns).toBe(10);
    expect(() =>
      loadConfig({ ...required, CHAT_HISTORY_TURNS: '-1' }),
    ).toThrow();
  });

  it('requires model credentials only for the openai provider', () => {
    expect(() =>
      loadConfig({ ...required, CHAT_PROVIDER: 'openai', OPENAI_API_KEY: '' }),
    ).toThrow();
    expect(
      loadConfig({
        ...required,
        CHAT_PROVIDER: 'openai',
        OPENAI_API_KEY: 'test-key',
      }).provider.type,
    ).toBe('openai');
  });

  it('rejects a non-WebSocket endpoint and missing OneBot credentials', () => {
    expect(() =>
      loadConfig({ ...required, ONEBOT_ENDPOINT: 'https://localhost:3001' }),
    ).toThrow();
    expect(() => loadConfig({ ...required, ONEBOT_TOKEN: '' })).toThrow();
  });
});
