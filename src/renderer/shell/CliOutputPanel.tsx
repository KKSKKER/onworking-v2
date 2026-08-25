// 底部面板:实时渲染 CLI 输出流(命令结果 + 进度/日志),AI 操作也会实时出现。
import { useEffect, useState } from 'react';
import { subscribeOutput } from '../cli';

export function CliOutputPanel() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const unsub = subscribeOutput((line) => {
      setLines((prev) => [...prev.slice(-499), line]);
    });
    return unsub;
  }, []);

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button className="active">CLI 输出流</button>
      </div>
      <div className="log-area">
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
