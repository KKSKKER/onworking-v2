// 左侧栏:文件管理 → 大表树(可展开源文件,选中联动视图);查询管理 → 管线列表。
import { useState } from 'react';
import { useApi } from '../views/useApi';
import { useSelection } from '../state/SelectionContext';
import type { ShellMode } from './TopBar';

export function SidebarLeft({ mode }: { mode: ShellMode }) {
  return mode === 'files' ? <BigTableTree /> : <PipelineList />;
}

function BigTableTree() {
  const { data: folders, reload } = useApi<string[]>({ cmd: 'bigtable.list' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { selectedFolder, selectedFile, selectFolder, selectFile } = useSelection();

  function toggleExpand(name: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">
        📁 大表 <button onClick={reload}>刷新</button>
      </div>
      <ul className="tree">
        {(folders ?? []).map((folder) => (
          <TreeFolder
            key={folder}
            folder={folder}
            expanded={expanded.has(folder)}
            selected={selectedFolder === folder}
            selectedFile={selectedFile}
            onToggle={() => toggleExpand(folder)}
            onSelectFolder={() => selectFolder(folder)}
            onSelectFile={selectFile}
          />
        ))}
        <li className="add">+ 新建大表</li>
      </ul>
    </div>
  );
}

function TreeFolder(props: {
  folder: string;
  expanded: boolean;
  selected: boolean;
  selectedFile: string | null;
  onToggle: () => void;
  onSelectFolder: () => void;
  onSelectFile: (file: string) => void;
}) {
  const { folder, expanded, selected, selectedFile, onToggle, onSelectFolder, onSelectFile } = props;
  const { data: files } = useApi<string[]>({ cmd: 'bigtable.sourceFiles', folder }, expanded);

  return (
    <li>
      <span
        className={`tree-folder ${selected ? 'selected' : ''}`}
        onClick={onToggle}
        onDoubleClick={onSelectFolder}
      >
        <span className="tree-caret">{expanded ? '▾' : '▸'}</span> 🗂 {folder}
      </span>
      {expanded && (files ?? []).length > 0 && (
        <ul className="tree-sub">
          {(files ?? []).map((file) => {
            const name = file.split(/[\\/]/).pop() ?? file;
            return (
              <li
                key={file}
                className={`tree-file ${selectedFile === file ? 'selected' : ''}`}
                onClick={() => onSelectFile(file)}
              >
                📄 {name}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function PipelineList() {
  const { data: pipelines, reload } = useApi<string[]>({ cmd: 'pipeline.list' });
  const { selectedFile } = useSelection();
  void selectedFile;
  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">
        🛠 管线 <button onClick={reload}>刷新</button>
      </div>
      <ul className="tree">
        {(pipelines ?? []).map((id) => (
          <li key={id}>⚙ {id}</li>
        ))}
        <li className="add">+ 新建查询</li>
      </ul>
    </div>
  );
}
