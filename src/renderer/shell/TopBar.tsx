// 顶栏:文件/查询管理切换 · AI开放模式 · 语言 · 打开工作区。
import { useState } from 'react';

export type ShellMode = 'files' | 'query';

export function TopBar({ mode, onModeChange }: { mode: ShellMode; onModeChange: (m: ShellMode) => void }) {
  const [aiMode, setAiMode] = useState('off');
  const [lang, setLang] = useState('zh');
  const [wsName, setWsName] = useState('未打开');

  async function handlePick() {
    const res = await window.onw.invoke({ cmd: 'workspace.pick' });
    if (res.ok) {
      const ws = res.data as { root: string };
      setWsName(ws.root);
    }
  }

  return (
    <div className="topbar">
      <span className="brand">OnWorking</span>
      <span className="ws-name" title={wsName}>{wsName}</span>
      <div className="mode-switch">
        <button className={mode === 'files' ? 'active' : ''} onClick={() => onModeChange('files')}>文件管理</button>
        <button className={mode === 'query' ? 'active' : ''} onClick={() => onModeChange('query')}>查询管理</button>
      </div>
      <div className="spacer" />
      <button onClick={handlePick}>打开工作区</button>
      <span className="ctrl">
        AI开放模式
        <select value={aiMode} onChange={(e) => setAiMode(e.target.value)}>
          <option value="off">关闭</option>
          <option value="external">外部(仅元数据)</option>
          <option value="local">本地(可查数据)</option>
        </select>
      </span>
      <span className="ctrl">
        语言
        <select value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </span>
    </div>
  );
}
