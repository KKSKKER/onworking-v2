// 底部面板:实时渲染 CLI 输出流(命令结果 + 进度/日志),AI 操作也会实时出现。
// 自动滚到底部(新行追加时),方便一直看最新输出。
// 大结果行只做摘要展示(不渲染每行原始数据),避免面板被几 MB JSON 塞满卡顿。
import { useEffect, useRef, useState } from 'react';
import { subscribeOutput } from '../cli';

const MAX_LINE = 400;

/** 结果行摘要:大 JSON(rows/数组)只统计,不渲染原始数据;超长行截断。 */
function summarizeLine(line: string): string {
  if (line.length <= MAX_LINE) return line;
  try {
    const msg = JSON.parse(line) as { result?: { ok?: boolean; data?: unknown } };
    const data = msg.result?.data;
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { rows?: unknown[] }).rows)) {
      const d = data as { rows: unknown[]; total?: number; columns?: string[] };
      return `{${msg.result?.ok ? 'ok' : 'error'}} 结果 ${d.rows.length}/${d.total ?? d.rows.length} 行 · ${(d.columns ?? []).length} 列`;
    }
    if (Array.isArray(data)) return `{${msg.result?.ok ? 'ok' : 'error'}} ${data.length} 项`;
  } catch {
    // 非 JSON 行,走截断
  }
  return `${line.slice(0, MAX_LINE)}…(${line.length}字符)`;
}

export function CliOutputPanel() {
  const [lines, setLines] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribeOutput((line) => {
      setLines((prev) => [...prev.slice(-499), line]);
    });
    return unsub;
  }, []);

  // 新行到达时滚到底部(若用户接近底部才跟随,避免往上翻历史时被拉回)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button className="active">CLI 输出流</button>
      </div>
      <div className="log-area" ref={scrollRef}>
        {lines.length === 0 && (
          <div style={{ color: '#8b949e' }}>暂无输出 — 执行命令或 AI 操作后这里实时显示。</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={l.includes('"ok":false') || l.includes('ERROR') ? 'log-error' : ''}>
            {summarizeLine(l)}
          </div>
        ))}
      </div>
    </div>
  );
}
