// 顶栏:合并(当前/全部) · 增加视图 · AI开放模式 · 语言 · 打开工作区。
import { useCallback, useEffect, useState } from 'react';
import { VIEWS } from '../views/registry';
import { useSelection } from '../state/SelectionContext';
import { sendCli } from '../cli';
import { triggerRefresh } from '../refresh';

interface MergeSummary {
  pipelineId: string;
  kind: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

export function TopBar({ onAddView }: { onAddView: (viewId: string) => void }) {
  const [aiMode, setAiMode] = useState<'external' | 'local'>('external');

  // 读取工作区 AI 开放模式(存于 .onworking/settings.json)。挂载/打开工作区/工作区变化时读,保持同步。
  const loadAiMode = useCallback(() => {
    void sendCli({ cmd: 'settings.get' }).then((res) => {
      if (res.ok) setAiMode((res.data as { aiOpenMode: 'external' | 'local' }).aiOpenMode);
    });
  }, []);

  useEffect(() => { loadAiMode(); }, [loadAiMode]);
  useEffect(() => {
    const unsub = window.onw.onWorkspaceChanged(loadAiMode);
    return unsub;
  }, [loadAiMode]);
  const [wsName, setWsName] = useState('未打开');
  const [addingView, setAddingView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState('');
  const { selectedFolder } = useSelection();

  async function handlePick() {
    const path = await window.onw.pickWorkspace();
    if (!path) return;
    const res = await window.onw.openWorkspace(path);
    if (res.ok) {
      setWsName(path);
      loadAiMode(); // 打开工作区后重读 AI 模式
      triggerRefresh(); // 打开工作区 → 所有视图自动刷新
    }
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
        <select
          value={aiMode}
          onChange={async (e) => {
            const mode = e.target.value as 'external' | 'local';
            setAiMode(mode);
            await sendCli({ cmd: 'settings.setAiMode', mode }); // 写入 .onworking/settings.json
          }}
        >
          <option value="external">外部(仅元数据)</option>
          <option value="local">本地(可查数据)</option>
        </select>
      </span>
    </div>
  );
}
