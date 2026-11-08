import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileText, Folder, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { load } from '@/lib/api';
import { memoryDocumentSchema, memoryIndexSchema } from '../contract';
import { DashboardNavigation } from './navigation';

function memoryLink(href: string, path: string): string | undefined {
  try {
    const url = new URL(
      /^(group|user)\//.test(href) ? `/${href}` : href,
      `https://memory.invalid/${path}`,
    );
    if (url.origin === 'https://memory.invalid')
      return decodeURIComponent(url.pathname.slice(1));
  } catch {
    /* Invalid links remain plain text. */
  }
  return undefined;
}

export function MemoryBrowser() {
  const [selected, setSelected] = useState<string | undefined>(
    new URLSearchParams(window.location.search).get('document') ?? undefined,
  );
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('');
  const index = useQuery({
    queryKey: ['memory'],
    queryFn: ({ signal }) => load('/api/memory', memoryIndexSchema, signal),
    refetchInterval: 30_000,
  });
  const paths = index.data?.paths ?? [];
  const matching = paths.filter(
    (path) =>
      (!scope || path.startsWith(`${scope}/`)) &&
      path.toLowerCase().includes(search.toLowerCase()),
  );
  const active = selected ?? matching[0];
  const folders = new Map<string, string[]>();
  for (const path of matching) {
    const folder = path.slice(0, path.lastIndexOf('/'));
    const entries = folders.get(folder) ?? [];
    entries.push(path);
    folders.set(folder, entries);
  }
  const detail = useQuery({
    queryKey: ['memory-document', active],
    queryFn: ({ signal }) =>
      load(
        `/api/memory/document?${new URLSearchParams({ path: active ?? '' })}`,
        memoryDocumentSchema,
        signal,
      ),
    enabled: Boolean(active),
    refetchInterval: 30_000,
  });
  useEffect(() => {
    const query = new URLSearchParams({ view: 'memory' });
    if (active) query.set('document', active);
    window.history.replaceState(null, '', `/?${query}`);
    document.title = active
      ? `${active.split('/').at(-1)} · Onxbot`
      : '记忆文档 · Onxbot';
  }, [active]);
  return (
    <div className="memory-page">
      <a className="skip-link" href="#memory-title">
        跳转到主要内容
      </a>
      <header className="topbar">
        <DashboardNavigation current="memory" />
        <span className="connection">只读浏览</span>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">MEMORY LIBRARY</div>
            <h1 id="memory-title" tabIndex={-1}>
              记忆文档<span className="heading-dot">.</span>
            </h1>
            <p>浏览群聊与成员记忆 · {paths.length} 份 Markdown 文档</p>
          </div>
          <Button
            disabled={index.isFetching}
            onClick={() => {
              void index.refetch();
              if (active) void detail.refetch();
            }}
          >
            <RefreshCw aria-hidden="true" />
            刷新文档
          </Button>
        </div>
        {index.error && (
          <div role="alert" className="notice error">
            {index.error.message}
            <Button variant="outline" onClick={() => void index.refetch()}>
              重试
            </Button>
          </div>
        )}
        <div className="memory-layout">
          <Card className="memory-list-card">
            <div className="filters">
              <h2>全部文档</h2>
              <label htmlFor="memory-search">搜索文件名或目录</label>
              <div className="search-control">
                <Search aria-hidden="true" />
                <Input
                  id="memory-search"
                  value={search}
                  placeholder="文件名、群号或成员号"
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelected(undefined);
                  }}
                />
              </div>
              <label htmlFor="memory-scope">记忆类型</label>
              <select
                id="memory-scope"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setSelected(undefined);
                }}
              >
                <option value="">全部记忆</option>
                <option value="group">群记忆</option>
                <option value="user">成员与私聊记忆</option>
              </select>
            </div>
            <nav aria-label="记忆文档目录" className="memory-folders">
              {[...folders].map(([folder, entries]) => (
                <section key={folder}>
                  <h3>
                    <Folder aria-hidden="true" />
                    {folder}
                  </h3>
                  <ul>
                    {entries.map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          aria-pressed={active === path}
                          className={`memory-file ${active === path ? 'selected' : ''}`}
                          onClick={() => setSelected(path)}
                        >
                          <FileText aria-hidden="true" />
                          <span>{path.split('/').at(-1)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
            {!matching.length && (
              <p className="empty-hint">
                {index.isPending
                  ? '正在读取目录'
                  : paths.length
                    ? '没有匹配的文档'
                    : '还没有记忆文档'}
              </p>
            )}
          </Card>
          <Card className="memory-document-card">
            {detail.error && detail.data && (
              <div role="alert" className="notice error">
                文档刷新失败 当前显示上次读取的内容
                <Button variant="outline" onClick={() => void detail.refetch()}>
                  重试读取
                </Button>
              </div>
            )}
            {active && detail.data ? (
              <>
                <header className="detail-header">
                  <div>
                    <div className="eyebrow">MARKDOWN DOCUMENT</div>
                    <h2>{active.split('/').at(-1)}</h2>
                    <p className="memory-path">{active}</p>
                  </div>
                  <BookOpen aria-hidden="true" />
                </header>
                <Tabs defaultValue="preview" className="memory-tabs">
                  <TabsList aria-label="文档查看方式">
                    <TabsTrigger value="preview">预览</TabsTrigger>
                    <TabsTrigger value="source">原文</TabsTrigger>
                  </TabsList>
                  <TabsContent value="preview">
                    <article
                      className="markdown-document"
                      aria-label="Markdown 预览"
                    >
                      <Markdown
                        skipHtml
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h1: 'h3',
                          h2: 'h4',
                          h3: 'h5',
                          h4: 'h6',
                          h5: 'h6',
                          h6: 'h6',
                          img: ({ alt }) => (
                            <span className="memory-image-placeholder">
                              [图片：{alt || '无描述'}]
                            </span>
                          ),
                          a: ({ href, children }) => {
                            if (href?.startsWith('#'))
                              return <a href={href}>{children}</a>;
                            const target = href
                              ? memoryLink(href, active)
                              : undefined;
                            if (target && paths.includes(target))
                              return (
                                <a
                                  href={`/?${new URLSearchParams({ view: 'memory', document: target })}`}
                                  onClick={(e) => {
                                    if (
                                      e.button === 0 &&
                                      !e.metaKey &&
                                      !e.ctrlKey &&
                                      !e.shiftKey &&
                                      !e.altKey
                                    ) {
                                      e.preventDefault();
                                      setSelected(target);
                                    }
                                  }}
                                >
                                  {children}
                                </a>
                              );
                            if (href && /^https?:\/\//i.test(href))
                              return (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {children}
                                </a>
                              );
                            return <span>{children}</span>;
                          },
                        }}
                      >
                        {detail.data.markdown}
                      </Markdown>
                    </article>
                  </TabsContent>
                  <TabsContent value="source">
                    <figure aria-label="Markdown 原文">
                      <pre className="code-block memory-source">
                        {detail.data.markdown}
                      </pre>
                    </figure>
                  </TabsContent>
                </Tabs>
              </>
            ) : (
              <div className="memory-placeholder">
                <BookOpen aria-hidden="true" />
                <h2>
                  {detail.error
                    ? '文档暂不可用'
                    : active
                      ? '正在读取文档'
                      : '选择一份记忆'}
                </h2>
                <p>
                  {detail.error?.message ??
                    '从左侧目录选择文档 查看 Markdown 内容'}
                </p>
                {detail.error && (
                  <Button
                    variant="outline"
                    onClick={() => void detail.refetch()}
                  >
                    重试读取
                  </Button>
                )}
              </div>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
