import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { TraceBuffer } from './traces.js';

const css = `
:root { color-scheme: light dark; font: 16px/1.55 system-ui, sans-serif; }
body { max-width: 70rem; margin: auto; padding: 2rem 1rem; }
header, form { margin-block-end: 1.5rem; }
h1, h2, p { margin-block: .5rem; }
h2 { font-size: 1.2rem; }
select, button { font: inherit; max-width: 100%; padding: .25rem; }
article { border: 1px solid GrayText; border-radius: .6rem; padding: 1rem; margin-block: 1rem; overflow-wrap: anywhere; }
details { margin-block: .5rem; }
summary { cursor: pointer; }
pre { padding: 1rem; background: color-mix(in srgb, CanvasText 6%, Canvas); white-space: pre-wrap; overflow-wrap: anywhere; }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function render(
  buffer: TraceBuffer,
  session: string | null,
  selected: string | null,
): string {
  const traces = buffer.list();
  const sessions = [...new Set(traces.map((trace) => trace.session))];
  const matching = traces.filter(
    (trace) => !session || trace.session === session,
  );
  const active =
    matching.find((trace) => String(trace.id) === selected) ?? matching[0];
  const turns = matching
    .map((trace) => {
      const query = new URLSearchParams({ turn: String(trace.id) });
      if (session) query.set('session', session);
      return `<li><a href="/?${escapeHtml(query.toString())}"${active === trace ? ' aria-current="page"' : ''}>#${trace.id} · ${escapeHtml(trace.session)} · ${trace.startedAt} · ${trace.status}</a></li>`;
    })
    .join('');
  const detail = active
    ? `<article><h2>回合 #${active.id} · ${active.status}</h2>
  <p>${escapeHtml(active.session)}</p>
  ${active.truncated ? '<p>部分事件超出大小限制，已截断。</p>' : ''}
  ${active.events.map((event, index) => `<details${index === 0 ? ' open' : ''}><summary>${index + 1}. ${event.phase === 'input' ? '模型输入' : '模型输出与工具结果'}</summary><pre>${escapeHtml(event.content)}</pre></details>`).join('')}
  </article>`
    : '<p>还没有模型调用。向 Bot 发送一条消息后刷新。</p>';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Onxbot · 会话观测</title><style>${css}</style>
<main><header><h1>会话观测</h1><p>最近 50 个模型回合 · 仅保存在进程内存 · 刷新查看最新状态</p></header>
<form action="/" method="get"><label for="session">会话</label>
<select id="session" name="session"><option value="">全部会话</option>
${sessions.map((entry) => `<option value="${escapeHtml(entry)}"${entry === session ? ' selected' : ''}>${escapeHtml(entry)}</option>`).join('')}
</select> <button>查看</button></form>
${detail}
${matching.length ? `<nav aria-label="模型回合"><h2>最近回合</h2><ol>${turns}</ol></nav>` : ''}
</main></html>`;
}

export function createObservationPanel(buffer: TraceBuffer, password: string) {
  const digest = (text: string) => createHash('sha256').update(text).digest();
  const expected = digest(
    `Basic ${Buffer.from(`onxbot:${password}`).toString('base64')}`,
  );
  const styleHash = createHash('sha256').update(css).digest('base64');
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (
      !timingSafeEqual(digest(request.headers.authorization ?? ''), expected)
    ) {
      response
        .writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Onxbot observation"',
        })
        .end();
      return;
    }
    const url = URL.parse(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET' || url?.pathname !== '/') {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        render(
          buffer,
          url.searchParams.get('session'),
          url.searchParams.get('turn'),
        ),
      );
  });
}
