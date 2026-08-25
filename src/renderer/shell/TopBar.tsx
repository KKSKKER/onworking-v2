// 顶栏:文件/查询管理切换 · 合并(当前/全部) · 增加视图 · AI开放模式 · 语言 · 打开工作区。
import { useState } from 'react';
import { VIEWS } from '../views/registry';
import { useSelection } from '../state/SelectionContext';
import { sendCli } from '../cli';

export type ShellMode = 'files' | 'query';

interface MergeSummary {
  pipelineId: string;
  kind: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

export function TopBar({
  mode,
  onModeChange,
  onAddView,
}: {
  mode: ShellMode;
  onModeChange: (m: ShellMode) => void;
  onAddView: (viewId: string) => void;
}) {
  const [aiMode, setAiMode] = useState('off');
  const [lang, setLang] = useState('zh');
  const [wsName, setWsName] = useState('未打开');
  const [addingView, setAddingView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState('');
  const { selectedFolder } = useSelection();

  async function handlePick() {
    const path = await window.onw.pickWorkspace();
    if (!path) return;
    const res = await window.onw.openWorkspace(path);
    if (res.ok) setWsName(path);
  }

  async function doAction(kind: 'mergeOne' | 'mergeAll' | 'masterOne' | 'masterAll') {
    const folder = selectedFolder;
    if ((kind === 'mergeOne' || kind === 'masterOne') && !folder) {
      setMergeMsg('请先在左侧栏选择大表');
      return;
    }
    setBusy(true);
    setMergeMsg('');
    const cmd =
      kind === 'mergeOne' ? ({ cmd: 'pipeline.mergeBigTable', folder: folder as string } as const)
      : kind === 'mergeAll' ? ({ cmd: 'pipeline.mergeAll' } as const)
      : kind === 'masterOne' ? ({ cmd: 'pipeline.buildMasterBigTable', folder: folder as string } as const)
      : ({ cmd: 'pipeline.buildMasterAll' } as const);
    const res = await sendCli(cmd);
    setBusy(false);
    if (!res.ok) {
      setMergeMsg(`失败: ${res.error.message}`);
      return;
    }
    const list = res.data as MergeSummary[];
    const okCount = list.filter((r) => r.ok).length;
    const totalRows = list.filter((r) => r.ok).reduce((s, r) => s + (r.rows ?? 0), 0);
    const label =
      kind === 'mergeOne' ? `合并「${selectedFolder}」`
      : kind === 'mergeAll' ? '全部合并'
      : kind === 'masterOne' ? `构建总表「${selectedFolder}」`
      : '全部构建总表';
    setMergeMsg(`${label}: ${okCount}/${list.length} 成功, ${totalRows} 行`);
  }

  return (
    <div className="topbar">
      <span className="brand">OnWorking</span>
      <span className="ws-name" title={wsName}>{wsName}</span>
      <div className="mode-switch">
        <button className={mode === 'files' ? 'active' : ''} onClick={() => onModeChange('files')}>文件管理</button>
        <button className={mode === 'query' ? 'active' : ''} onClick={() => onModeChange('query')}>查询管理</button>
      </div>
      <button onClick={() => doAction('mergeOne')} disabled={busy} title="按 YAML 规则把源文件合并进当前选中大表">▶ 合并当前</button>
      <button onClick={() => doAction('mergeAll')} disabled={busy} title="把工作区所有大表按规则合并一次">▶ 全部合并</button>
      <span className="topbar-sep" />
      <button onClick={() => doAction('masterOne')} disabled={busy} title="从当前选中大表构建总表">⇉ 总表当前</button>
      <button onClick={() => doAction('masterAll')} disabled={busy} title="从全部大表构建总表">⇉ 总表全部</button>
      {mergeMsg && <span className="topbar-msg">{mergeMsg}</span>}
      <div className="spacer" />
      <div className="view-add">
        <button onClick={() => setAddingView((v) => !v)}>+ 增加视图</button>
        {addingView && (
          <div className="view-menu">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => { onAddView(v.id); setAddingView(false); }}>
                {v.title}
              </button>
            ))}
          </div>
        )}
      </div>
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
