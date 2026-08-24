// 底部面板:日志栏(订阅真实日志流)+ 命令行栏(可切换)。
import { useEffect, useState } from 'react';

interface LogEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

function formatLog(e: LogEntry): string {
  const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
  const data = e.data && Object.keys(e.data).length > 0 ? ` ${JSON.stringify(e.data)}` : '';
  return `[${time}] ${(e.level ?? '').toUpperCase().padEnd(5)} ${e.module}: ${e.message}${data}`;
}

export function BottomPanel() {
  const [tab, setTab] = useState<'log' | 'cmd'>('log');
  const [logs, setLogs] = useState<string[]>([]);
  const [cmd, setCmd] = useState('');

  // 订阅主进程转发的核心日志流
  useEffect(() => {
    const unsub = window.onw.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-199), formatLog(entry as LogEntry)]);
    });
    return () => unsub();
  }, []);

  function handleCmdSubmit() {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    setLogs((l) => [...l.slice(-199), `> ${trimmed}`]);
    setCmd('');
  }

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>日志</button>
        <button className={tab === 'cmd' ? 'active' : ''} onClick={() => setTab('cmd')}>命令行</button>
      </div>
      {tab === 'log' ? (
        <div className="log-area">
          {logs.length === 0 && <div style={{ color: '#8b949e' }}>暂无日志 — 运行管线/查询后这里会显示真实日志。</div>}
          {logs.map((l, i) => (
            <div key={i} className={l.includes('ERROR') ? 'log-error' : ''}>{l}</div>
          ))}
        </div>
      ) : (
        <form
          className="cmd-area"
          onSubmit={(e) => {
            e.preventDefault();
            handleCmdSubmit();
          }}
        >
          <span>&gt;</span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder="输入命令,如: 重算全部管线"
          />
        </form>
      )}
    </div>
  );
}
