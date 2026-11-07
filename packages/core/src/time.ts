import { TZDate } from '@date-fns/tz';

/** Render an instant in the conversation's IANA time zone. */
export function chatTimestamp(value: string | number = Date.now()): string {
  const date = new TZDate(new Date(value), 'Asia/Shanghai');
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}
