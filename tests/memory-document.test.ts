import { expect, it } from 'vitest';
import { memoryBody } from '../packages/core/src/memory-document.js';

it('removes repeated legacy metadata without removing the event source time', () => {
  expect(
    memoryBody(
      [
        '# Club',
        '- source=2026-01-02T09:30:12+08:00; weekly reading club confirmed.',
        '',
        'Recorded at: 2026-01-02T09:35+08:00',
        'Recorded at: 2026-01-02T09:35:12.123+08:00',
        '',
        'Updated: 2026-01-03 10:15',
        '',
        '- The club now meets on Wednesday.',
        '',
        'Recorded at: 2026-01-03T10:15:00Z',
      ].join('\r\n'),
    ),
  ).toBe(
    [
      '# Club',
      '- source=2026-01-02T09:30:12+08:00; weekly reading club confirmed.',
      '',
      '- The club now meets on Wednesday.',
    ].join('\n'),
  );
});

it('normalizes explicit instants across dates while preserving time precision', () => {
  expect(
    memoryBody(
      [
        'source=2026-01-02 19:45Z',
        'event=2026-01-02T23:30:12-05:00',
        'source=2026-01-02 09:30:12.123456+08:00',
        'source=2026-01-02T09:30:12.1+09:00',
      ].join('\n'),
    ),
  ).toBe(
    [
      'source=2026-01-03T03:45+08:00',
      'event=2026-01-03T12:30:12+08:00',
      'source=2026-01-02T09:30:12.123456+08:00',
      'source=2026-01-02T08:30:12.1+08:00',
    ].join('\n'),
  );
});

it('does not guess unknown dates, offsets, or invalid calendar values', () => {
  const body = [
    'event=2026-01-02; time unknown',
    'source=2026-01-02 09:30; offset unknown',
    'The source only says 09:30 or tomorrow.',
    'source=2026-02-30T09:30:12+08:00',
    'source=2026-01-02T25:30:12Z',
  ].join('\n');
  expect(memoryBody(body)).toBe(body);
});

it('preserves quoted evidence and fenced, inline, and indented code examples', () => {
  const body = [
    '# Examples',
    '> Recorded at: 2026-01-02T09:30Z',
    '> Updated: 2026-01-02T09:30Z',
    '`2026-01-02 09:30Z`',
    '    Recorded at: 2026-01-02T09:30Z',
    '```md',
    'Recorded at: 2026-01-02T09:30Z',
    '',
    '',
    'Updated: 2026-01-02T09:30Z',
    '```',
    '~~~~md',
    'Recorded at: 2026-01-02T09:30Z',
    '~~~',
    'Updated: 2026-01-02T09:30Z',
    '~~~~',
    'The label Recorded at: describes storage metadata.',
  ].join('\n');
  expect(memoryBody(body)).toBe(body);
});

it('is idempotent and leaves no body when the input is only metadata', () => {
  const body =
    '# Club\n\nsource=2026-01-02 01:30:12Z\n\nRecorded at: unknown\n';
  expect(memoryBody(memoryBody(body))).toBe(memoryBody(body));
  expect(
    memoryBody('Recorded at: 2026-01-02T09:30+08:00\n\nUpdated: unknown'),
  ).toBe('');
});
