import { Activity, BookOpen } from 'lucide-react';

export function DashboardNavigation({
  current,
}: {
  current: 'traces' | 'memory';
}) {
  return (
    <nav aria-label="页面导航" className="page-navigation">
      <a href="/" aria-current={current === 'traces' ? 'page' : undefined}>
        <Activity aria-hidden="true" />
        会话追踪
      </a>
      <a
        href="/?view=memory"
        aria-current={current === 'memory' ? 'page' : undefined}
      >
        <BookOpen aria-hidden="true" />
        记忆文档
      </a>
    </nav>
  );
}
