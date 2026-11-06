import { defineTool, type Tool } from '@onxbot/core';
import { z } from 'zod';

const endpoint = 'https://api.deepseek.com/v1/tools';
const querySchema = z.string().trim().min(1).max(128);
const urlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);
    return url !== null && !url.username && !url.password;
  });
const searchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      summary: z.string().optional(),
      snippet: z.string().optional(),
    }),
  ),
});
const pageSchema = z.object({ title: z.string(), content: z.string() });

export function createWebResearchTools(
  apiKey: string,
  request: typeof fetch = fetch,
): () => readonly Tool[] {
  async function call(
    path: 'search' | 'fetch',
    body: Record<string, string | number | boolean>,
  ): Promise<unknown> {
    const response = await request(`${endpoint}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Web research request failed.');
    }
    return response.json();
  }

  return () => {
    const availablePages = new Set<string>();
    let remaining = 3;
    return [
      defineTool({
        name: 'search_web',
        lookup: true,
        description:
          'Search public pages for an unfamiliar meme, abbreviation, or concept. The query MUST contain only necessary keywords. Returns titles, links, and summaries.',
        input: z.object({ query: querySchema }),
        async execute({ query }) {
          if (!remaining) return '本轮网页检索额度已用完。';
          remaining -= 1;
          try {
            const data = searchSchema.parse(
              await call('search', { query, count: 3, need_content: false }),
            );
            const results = data.results.slice(0, 3).flatMap((item) => {
              if (!urlSchema.safeParse(item.url).success) return [];
              availablePages.add(item.url);
              return [
                {
                  url: item.url,
                  title: item.title.slice(0, 200),
                  summary: (item.summary || item.snippet || '').slice(0, 800),
                },
              ];
            });
            return results.length ? JSON.stringify(results) : '没有找到结果。';
          } catch {
            return '网页搜索暂不可用。';
          }
        },
      }),
      defineTool({
        name: 'fetch_page',
        lookup: true,
        description:
          'Read a Markdown excerpt from a public page. The URL MUST come from search_web results in the current turn.',
        input: z.object({ url: urlSchema }),
        async execute({ url }) {
          if (!availablePages.has(url))
            return '请先搜索，并使用本轮搜索结果中的链接。';
          if (!remaining) return '本轮网页检索额度已用完。';
          remaining -= 1;
          try {
            const data = pageSchema.parse(await call('fetch', { url }));
            if (!data.content.trim()) return '网页没有可读正文。';
            return JSON.stringify({
              url,
              title: data.title.slice(0, 200),
              content: data.content.slice(0, 5_000),
              truncated: data.content.length > 5_000,
            });
          } catch {
            return '暂时无法读取该网页。';
          }
        },
      }),
    ];
  };
}
