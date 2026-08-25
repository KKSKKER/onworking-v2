// 底部面板:实时渲染 CLI 输出流(命令结果 + 进度/日志),AI 操作也会实时出现。
// 自动滚到底部(新行追加时),方便一直看最新输出。
import { useEffect, useRef, useState } from 'react';
import { subscribeOutput } from '../cli';

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
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
