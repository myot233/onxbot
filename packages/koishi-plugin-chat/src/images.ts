import { type ChatImage, maxChatImages } from '@onxbot/core';
import type { Session } from 'koishi';

const imageHosts = new Set([
  'multimedia.nt.qq.com.cn',
  'multimedia.nt.qq.com',
  'gchat.qpic.cn',
  'c2cpicdw.qpic.cn',
  'gxh.vip.qq.com',
]);
const maxImageBytes = 5 * 1024 * 1024;

function imageMediaType(data: Buffer): `image/${string}` | undefined {
  const signature = data.toString('latin1', 0, 12);
  if (signature.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (signature.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a'))
    return 'image/gif';
  if (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP')
    return 'image/webp';
}

async function loadImage(source: unknown) {
  const url = typeof source === 'string' ? URL.parse(source) : null;
  if (
    !url ||
    !imageHosts.has(url.hostname) ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.port ||
    url.username ||
    url.password
  )
    return;
  url.protocol = 'https:';

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (
    !response.ok ||
    Number(response.headers.get('content-length')) > maxImageBytes
  ) {
    await response.body?.cancel();
    return;
  }
  if (!response.body) return;

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxImageBytes) return;
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, size);
  const mediaType = imageMediaType(data);
  if (mediaType) return { data, mediaType };
}

export function chatImages(session: Session | undefined): ChatImage[] {
  const images: ChatImage[] = [];
  const collect = (elements: Session['elements'], quoted: boolean) => {
    for (const element of elements ?? []) {
      if (images.length >= maxChatImages) break;
      if (element.type !== 'img') continue;
      const source: unknown = element.attrs.src;
      images.push({ quoted, load: () => loadImage(source) });
    }
  };
  collect(session?.elements, false);
  collect(session?.quote?.elements, true);
  return images;
}
