// 左侧栏:文件管理 → 大表树;查询管理 → 管线列表。
import { useApi } from '../views/useApi';
import type { ShellMode } from './TopBar';

export function SidebarLeft({ mode }: { mode: ShellMode }) {
  return mode === 'files' ? <BigTableTree /> : <PipelineList />;
}

function BigTableTree() {
  const { data: folders, reload } = useApi<string[]>({ cmd: 'bigtable.list' });
  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">📁 大表 <button onClick={reload}>刷新</button></div>
      <ul className="tree">
        {(folders ?? []).map((f) => (
          <li key={f}>🗂 {f}</li>
        ))}
        <li className="add">+ 新建大表</li>
      </ul>
    </div>
  );
}

function PipelineList() {
  const { data: pipelines, reload } = useApi<string[]>({ cmd: 'pipeline.list' });
  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">🛠 管线 <button onClick={reload}>刷新</button></div>
      <ul className="tree">
        {(pipelines ?? []).map((id) => (
          <li key={id}>⚙ {id}</li>
        ))}
        <li className="add">+ 新建查询</li>
      </ul>
    </div>
  );
}
