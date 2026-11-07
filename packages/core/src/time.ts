/** QQ conversation times use modern Asia/Shanghai time (UTC+08:00). */
export function chatTimestamp(value: string | number = Date.now()): string {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return 'unknown';
  return new Date(milliseconds + 8 * 60 * 60_000)
    .toISOString()
    .replace('Z', '+08:00');
}
