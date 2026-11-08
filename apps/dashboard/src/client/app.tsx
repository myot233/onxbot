import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Braces,
  Check,
  CircleDot,
  Clock3,
  Layers3,
  MessageSquare,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { load } from '@/lib/api';
import {
  modelInputSchema,
  modelOutputSchema,
  type Trace,
  type TraceSummary,
  traceIndexSchema,
  traceSchema,
} from '../contract';
import { DashboardNavigation } from './navigation';

const initial = new URLSearchParams(window.location.search);
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const date = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
});
const showTime = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? time.format(new Date(value))
    : '时间未知';
const pretty = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
function parse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
function sessionName(value: string) {
  const parts = value.split('/');
  const id = parts.at(-1);
  if (value.includes('/memory-review/')) return `记忆回顾 · ${id}`;
  if (value.includes('/group/')) return `群聊 · ${id}`;
  return value;
}
function kind(value: string) {
  return value.includes('/memory-review/')
    ? '记忆回顾'
    : value.includes('/group/')
      ? '群聊'
      : '对话';
}
function Status({ status }: { status: TraceSummary['status'] }) {
  return (
    <Badge
      variant="outline"
      className={`status status-${status === '完成' ? 'done' : status === '失败' || status === '中断' ? 'failed' : 'running'}`}
    >
      <span className="status-dot" />
      {status}
    </Badge>
  );
}
function Code({ value, label }: { value: unknown; label: string }) {
  return (
    <figure aria-label={label}>
      <pre className="code-block">{pretty(value)}</pre>
    </figure>
  );
}
function Messages({ input }: { input: z.infer<typeof modelInputSchema> }) {
  return (
    <div className="message-stack">
      {input.instructions !== undefined && (
        <article className="context-message">
          <div className="message-label">
            <Badge variant="secondary">instructions</Badge>
          </div>
          <Code value={input.instructions} label="模型指令" />
        </article>
      )}
      {input.messages.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Message positions are fixed within this recorded model call.
        <article className="context-message" key={`${index}-${message.role}`}>
          <div className="message-label">
            <Badge variant="secondary">{message.role}</Badge>
            <span>消息 {index + 1}</span>
          </div>
          <Code
            value={message.content}
            label={`${message.role} 消息 ${index + 1}`}
          />
        </article>
      ))}
    </div>
  );
}
function Detail({ trace }: { trace: Trace }) {
  const inputs = trace.events.flatMap((event, index) => {
    if (event.phase !== 'input') return [];
    const data = modelInputSchema.safeParse(parse(event.content));
    return data.success ? [{ index, input: data.data }] : [];
  });
  const first = inputs[0]?.input;
  const calls = trace.events.flatMap((event) =>
    event.phase === 'output'
      ? (modelOutputSchema.safeParse(parse(event.content)).data?.toolCalls ??
        [])
      : [],
  );
  const elapsed =
    trace.status === '中断'
      ? '异常中断'
      : trace.finishedAt
        ? `${((Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) / 1000).toFixed(1)} s`
        : '进行中';
  return (
    <Card className="detail-card">
      <header className="detail-header">
        <div>
          <div className="eyebrow">TRACE DETAIL</div>
          <h2>
            回合{' '}
            <span className="mono">#{String(trace.id).padStart(4, '0')}</span>
          </h2>
          <p>{sessionName(trace.session)}</p>
        </div>
        <Status status={trace.status} />
      </header>
      <dl className="detail-metadata">
        <div>
          <dt>模型</dt>
          <dd>{first?.modelId ?? '未记录'}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd className="mono">{elapsed}</dd>
        </div>
        <div>
          <dt>模型调用</dt>
          <dd>{trace.events.filter((e) => e.phase === 'input').length} 次</dd>
        </div>
        <div>
          <dt>工具调用</dt>
          <dd>{calls.length} 次</dd>
        </div>
      </dl>
      {trace.truncated && (
        <p className="notice">
          这个回合的部分事件已达到保留上限 内容可能不完整
        </p>
      )}
      <Tabs defaultValue="flow" className="detail-tabs">
        <TabsList aria-label="回合详情视图">
          <TabsTrigger value="flow">
            <Activity aria-hidden="true" />
            执行过程
          </TabsTrigger>
          <TabsTrigger value="context">
            <Layers3 aria-hidden="true" />
            模型上下文
          </TabsTrigger>
          <TabsTrigger value="raw">
            <Braces aria-hidden="true" />
            原始事件
          </TabsTrigger>
        </TabsList>
        <TabsContent value="flow" className="flow-content">
          <div className="section-caption">
            <h3>模型与工具的完整路径</h3>
            <span>{trace.events.length} 个事件</span>
          </div>
          <ol className="event-list">
            {trace.events.map((event, index) => {
              const output =
                event.phase === 'output'
                  ? modelOutputSchema.safeParse(parse(event.content)).data
                  : undefined;
              const input =
                event.phase === 'input'
                  ? modelInputSchema.safeParse(parse(event.content)).data
                  : undefined;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: Events are append-only and positions identify events within a trace.
                <li className="event-item" key={`${trace.id}-${index}`}>
                  <div className={`event-icon ${event.phase}`}>
                    {event.phase === 'input' ? (
                      <ArrowUpRight aria-hidden="true" />
                    ) : (
                      <ArrowDownLeft aria-hidden="true" />
                    )}
                  </div>
                  <article className="event-body">
                    <div className="event-title">
                      <h4>
                        {event.phase === 'input' ? '模型输入' : '模型输出'}
                      </h4>
                      <span className="mono">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                    </div>
                    {input && (
                      <>
                        <p className="event-description">
                          {input.messages.length} 条消息 · {input.tools.length}{' '}
                          个可用工具
                        </p>
                        <details>
                          <summary>查看本次调用的上下文</summary>
                          <Messages input={input} />
                        </details>
                      </>
                    )}
                    {output && (
                      <>
                        {output.text && (
                          <p className="model-reply">{output.text}</p>
                        )}
                        {output.toolCalls.map((call) => (
                          <div className="tool-card" key={call.toolCallId}>
                            <div className="tool-title">
                              <Wrench aria-hidden="true" />
                              <span>{call.toolName}</span>
                              <Badge variant="secondary">调用</Badge>
                            </div>
                            <Code
                              value={call.input}
                              label={`${call.toolName} 参数`}
                            />
                          </div>
                        ))}
                        {output.toolResults.map((result) => (
                          <details
                            className="tool-result"
                            key={result.toolCallId}
                          >
                            <summary>
                              <Check aria-hidden="true" />
                              {result.toolName} · 工具结果
                            </summary>
                            <Code
                              value={result.output}
                              label={`${result.toolName} 结果`}
                            />
                          </details>
                        ))}
                        {!output.text &&
                          !output.toolCalls.length &&
                          !output.toolResults.length && (
                            <p className="event-description">
                              模型未输出文本或工具调用
                            </p>
                          )}
                      </>
                    )}
                    {!input && !output && (
                      <Code
                        value={event.content}
                        label={`事件 ${index + 1} 原始内容`}
                      />
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        </TabsContent>
        <TabsContent value="context">
          <div className="section-caption">
            <h3>每一步实际发送给模型的信息</h3>
          </div>
          {inputs.length ? (
            <Tabs defaultValue={String(inputs[0]?.index)}>
              <TabsList className="step-tabs" aria-label="选择模型调用">
                {inputs.map(({ index }, i) => (
                  <TabsTrigger key={index} value={String(index)}>
                    调用 {i + 1}
                  </TabsTrigger>
                ))}
              </TabsList>
              {inputs.map(({ index, input }) => (
                <TabsContent key={index} value={String(index)}>
                  <div className="available-tools">
                    <span>可用工具</span>
                    {input.tools.length ? (
                      input.tools.map((tool) => (
                        <Badge key={tool} variant="outline">
                          {tool}
                        </Badge>
                      ))
                    ) : (
                      <span>无</span>
                    )}
                  </div>
                  <Messages input={input} />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <p className="empty-hint">没有完整的模型输入事件 请查看原始事件</p>
          )}
        </TabsContent>
        <TabsContent value="raw">
          <div className="section-caption">
            <h3>原始 trace 数据</h3>
            <span>只读</span>
          </div>
          <Code value={trace} label="回合原始 JSON" />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
const MemoryBrowser = lazy(() =>
  import('./memory-browser').then((module) => ({
    default: module.MemoryBrowser,
  })),
);

export function App() {
  return new URLSearchParams(window.location.search).get('view') ===
    'memory' ? (
    <Suspense
      fallback={
        <main>
          <h1>正在打开记忆文档</h1>
        </main>
      }
    >
      <MemoryBrowser />
    </Suspense>
  ) : (
    <TraceDashboard />
  );
}
function TraceDashboard() {
  const [auto, setAuto] = useState(true);
  const [session, setSession] = useState(initial.get('session') ?? '');
  const [selected, setSelected] = useState<number | undefined>(
    initial.has('turn') ? Number(initial.get('turn')) : undefined,
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const before = cursors.at(-1);
  const params = new URLSearchParams({ limit: '50' });
  if (session) params.set('session', session);
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (before) params.set('before', String(before));
  const query = params.toString();
  const index = useQuery({
    queryKey: ['traces', query],
    queryFn: ({ signal }) =>
      load(`/api/traces?${query}`, traceIndexSchema, signal),
    refetchInterval: auto ? 5000 : false,
  });
  const traces = index.data?.traces ?? [];
  const sessions = [
    ...new Set([
      ...(session ? [session] : []),
      ...traces.map((trace) => trace.session),
    ]),
  ];
  const matching = traces;
  const filtered = Boolean(session || status || search || before);
  const activeId = selected ?? traces[0]?.id;
  const active = traces.find((trace) => trace.id === activeId);
  const detail = useQuery({
    queryKey: [
      'trace',
      index.data?.startedAt,
      activeId,
      active?.eventCount,
      active?.status,
    ],
    queryFn: ({ signal }) =>
      load(`/api/traces/${activeId}`, traceSchema, signal),
    enabled: Boolean(activeId),
    refetchInterval:
      auto &&
      (active?.status === '运行中' || (!active && activeId !== undefined))
        ? 5000
        : false,
  });
  const chooseSession = (value: string) => {
    setSession(value);
    setSelected(undefined);
    setCursors([undefined]);
  };
  useEffect(() => {
    const query = new URLSearchParams();
    if (session) query.set('session', session);
    if (activeId) query.set('turn', String(activeId));
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query.size ? `?${query}` : ''}`,
    );
    document.title = activeId
      ? `回合 #${activeId} · Onxbot`
      : '会话追踪 · Onxbot';
  }, [session, activeId]);
  return (
    <div className="dashboard">
      <a className="skip-link" href="#main-title">
        跳转到主要内容
      </a>
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">
            <Terminal aria-hidden="true" />
          </span>
          <span>
            onxbot<span className="brand-caption">OBSERVABILITY</span>
          </span>
        </a>
        <div className="workspace-label">
          工作空间 <Badge variant="outline">LIVE</Badge>
        </div>
        <nav aria-label="会话">
          <button
            type="button"
            className={`sidebar-link ${!session ? 'is-active' : ''}`}
            onClick={() => chooseSession('')}
            aria-pressed={!session}
          >
            <Activity aria-hidden="true" />
            全部会话<span>{sessions.length}</span>
          </button>
          <p className="sidebar-caption">最近的会话</p>
          <ul>
            {sessions.map((value) => (
              <li key={value}>
                <button
                  type="button"
                  className={`sidebar-link session-link ${session === value ? 'is-active' : ''}`}
                  aria-pressed={session === value}
                  onClick={() => chooseSession(value)}
                >
                  <MessageSquare aria-hidden="true" />
                  <span>{sessionName(value)}</span>
                </button>
              </li>
            ))}
          </ul>
          {!sessions.length && (
            <p className="sidebar-empty">有模型调用后会显示在这里</p>
          )}
        </nav>
        <footer className="sidebar-footer">
          <Radio aria-hidden="true" />
          <div>
            只读观测<span>PostgreSQL 持久保存回合</span>
          </div>
        </footer>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <DashboardNavigation current="traces" />
          <span className="connection">
            <span
              className={`connection-dot ${index.isError ? 'offline' : ''}`}
            />
            {index.isError
              ? '连接异常'
              : index.data
                ? '面板已连接'
                : '正在连接'}
          </span>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">CONVERSATION TRACES</div>
              <h1 id="main-title" tabIndex={-1}>
                会话追踪<span className="heading-dot">.</span>
              </h1>
              <p>从上下文到回复 看清每一步发生了什么</p>
            </div>
            <div className="heading-actions">
              <Button
                variant="outline"
                aria-pressed={auto}
                onClick={() => setAuto(!auto)}
              >
                {auto ? (
                  <Pause aria-hidden="true" />
                ) : (
                  <Play aria-hidden="true" />
                )}
                {auto ? '自动刷新中' : '已暂停刷新'}
              </Button>
              <Button
                onClick={() => {
                  void index.refetch();
                  if (activeId) void detail.refetch();
                }}
                disabled={index.isFetching}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={index.isFetching ? 'refreshing' : ''}
                />
                刷新
              </Button>
            </div>
          </div>
          <div className="metrics">
            {[
              {
                label: '本页回合',
                value: traces.length,
                note: `每页 ${index.data?.limit ?? 50} 个`,
                icon: Layers3,
              },
              {
                label: '本页运行中',
                value: traces.filter((t) => t.status === '运行中').length,
                note: '等待模型或工具返回',
                icon: Activity,
              },
              {
                label: '本页异常',
                value: traces.filter(
                  (t) => t.status === '失败' || t.status === '中断',
                ).length,
                note: '包含失败和中断',
                icon: CircleDot,
              },
              {
                label: '本页会话',
                value: sessions.length,
                note: '按当前页会话标识区分',
                icon: MessageSquare,
              },
            ].map(({ label, value, note, icon: Icon }) => (
              <Card className="metric" key={label}>
                <dl>
                  <dt>
                    {label}
                    <Icon aria-hidden="true" />
                  </dt>
                  <dd>{index.isPending ? '—' : value}</dd>
                </dl>
                <p>{note}</p>
              </Card>
            ))}
          </div>
          {index.error && (
            <div role="alert" className="notice error">
              {index.error.message}{' '}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void index.refetch()}
              >
                重试
              </Button>
            </div>
          )}
          <div className="traces-heading">
            <h2>
              历史回合 <Badge variant="secondary">{matching.length}</Badge>
            </h2>
            <span>
              <Clock3 aria-hidden="true" />
              {index.dataUpdatedAt
                ? `${showTime(new Date(index.dataUpdatedAt).toISOString())} 更新 · 北京时间`
                : '等待首次数据'}
            </span>
          </div>
          <div className="trace-layout">
            <Card className="trace-list-card">
              <div className="filters">
                <label htmlFor="trace-search">搜索回合</label>
                <div className="search-control">
                  <Search aria-hidden="true" />
                  <Input
                    id="trace-search"
                    placeholder="会话标识或回合编号"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setSelected(undefined);
                      setCursors([undefined]);
                    }}
                  />
                </div>
                <div className="select-filters">
                  <div>
                    <label htmlFor="session-filter">会话</label>
                    <select
                      id="session-filter"
                      value={session}
                      onChange={(e) => chooseSession(e.target.value)}
                    >
                      <option value="">全部会话</option>
                      {sessions.map((value) => (
                        <option key={value} value={value}>
                          {sessionName(value)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="status-filter">状态</label>
                    <select
                      id="status-filter"
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value);
                        setSelected(undefined);
                        setCursors([undefined]);
                      }}
                    >
                      <option value="">全部状态</option>
                      {['运行中', '完成', '失败', '中断'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              {index.isPending && <p className="empty-hint">正在读取回合</p>}
              <ol className="trace-list">
                {matching.map((trace) => (
                  <li key={trace.id}>
                    <button
                      type="button"
                      className={`trace-row ${active?.id === trace.id ? 'selected' : ''}`}
                      aria-pressed={active?.id === trace.id}
                      onClick={() => setSelected(trace.id)}
                    >
                      <div className="trace-row-top">
                        <span className="trace-id mono">
                          #{String(trace.id).padStart(4, '0')}
                        </span>
                        <Status status={trace.status} />
                      </div>
                      <div className="trace-session">
                        {sessionName(trace.session)}
                      </div>
                      <div className="trace-row-bottom">
                        <span>
                          {date.format(new Date(trace.startedAt))}{' '}
                          {showTime(trace.startedAt)}
                        </span>
                        <span>
                          {kind(trace.session)} · {trace.eventCount} 事件
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ol>
              <nav aria-label="回合分页" className="trace-pagination">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursors.length === 1 || index.isFetching}
                  onClick={() => {
                    setCursors(cursors.slice(0, -1));
                    setSelected(undefined);
                  }}
                >
                  上一页
                </Button>
                <span>第 {cursors.length} 页</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!index.data?.nextCursor || index.isFetching}
                  onClick={() => {
                    const next = index.data?.nextCursor;
                    if (next) {
                      setCursors([...cursors, next]);
                      setSelected(undefined);
                    }
                  }}
                >
                  更早回合
                </Button>
              </nav>
              {!index.isPending && !matching.length && (
                <div className="list-empty">
                  <Search aria-hidden="true" />
                  <p>{filtered ? '没有匹配的回合' : '还没有模型调用'}</p>
                  <span>
                    {filtered
                      ? '试试其他筛选条件'
                      : '收到对话或定时任务运行后会显示在这里'}
                  </span>
                </div>
              )}
            </Card>
            <div className="detail-slot">
              {activeId && detail.data ? (
                <Detail
                  key={`${index.data?.startedAt}-${activeId}`}
                  trace={detail.data}
                />
              ) : (
                <Card className="detail-empty">
                  <div className="empty-icon">
                    <Layers3 aria-hidden="true" />
                  </div>
                  <h2>
                    {detail.error
                      ? '回合暂不可用'
                      : activeId
                        ? '正在读取详情'
                        : selected !== undefined
                          ? '这个回合已离开当前列表'
                          : '等待一个新的故事'}
                  </h2>
                  <p>
                    {detail.error?.message ??
                      (activeId
                        ? '正在加载实际的模型上下文'
                        : '选择左侧回合 查看模型输入与工具执行过程')}
                  </p>
                  {selected !== undefined && !active && (
                    <Button
                      variant="outline"
                      onClick={() => setSelected(undefined)}
                    >
                      查看最新回合
                    </Button>
                  )}
                </Card>
              )}
            </div>
          </div>
          <footer className="page-footer">
            <span>onxbot / conversation observability</span>
            <span>PostgreSQL 持久保存 · 重启不丢失</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
