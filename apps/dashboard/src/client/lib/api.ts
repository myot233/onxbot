import type { z } from 'zod';

export async function load<T>(
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store' });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? '内容不存在或已被移除'
        : `无法读取观测数据（${response.status}）`,
    );
  return schema.parse(await response.json());
}
