import type { UserContent } from '@onxbot/model';
import type { ChatImage } from '../types.js';

export async function buildChatContent(
  text: string,
  images: readonly ChatImage[] = [],
): Promise<UserContent> {
  if (!images.length) return text;

  const results = await Promise.allSettled(images.map((image) => image.load()));
  const parts: Exclude<UserContent, string> = text
    ? [{ type: 'text', text }]
    : [];
  for (const [index, result] of results.entries()) {
    const label = images[index]?.quoted ? '引用图片' : '图片';
    const image = result.status === 'fulfilled' ? result.value : undefined;
    parts.push({ type: 'text', text: `[${label}${image ? '' : '无法读取'}]` });
    if (image) parts.push({ type: 'file', ...image });
  }
  return parts.every((part) => part.type === 'text')
    ? parts.map((part) => part.text).join('\n')
    : parts;
}
