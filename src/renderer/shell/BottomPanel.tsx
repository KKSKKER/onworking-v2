// 底部面板:日志栏 + 命令行栏(可切换)。
import { useState } from 'react';

const INITIAL_LOGS = [
  '[INFO] pipeline/clean: clean start',
  '[INFO] pipeline/clean: clean complete',
  '[INFO] pipeline/engine: run ok',
];

export function BottomPanel() {
  const [tab, setTab] = useState<'log' | 'cmd'>('log');
  const [logs, setLogs] = useState<string[]>(INITIAL_LOGS);
  const [cmd, setCmd] = useState('');

  function handleCmdSubmit() {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    setLogs((l) => [...l, `> ${trimmed}`]);
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
          {logs.map((l, i) => (
            <div key={i} className={l.startsWith('[ERROR]') ? 'log-error' : ''}>{l}</div>
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
