// 左侧栏:文件管理 → 大表树(单击=选中+展开,参考 V1 FolderTree);查询管理 → 管线列表。
import { useEffect, useState } from 'react';
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

  // 自动选中第一个大表(仅当完全没有选中时,避免与「选中文件」打架——否则选文件后 folder 变空又被抢回)
  useEffect(() => {
    if (!selectedFolder && !selectedFile && folders && folders.length > 0) {
      selectFolder(folders[0]);
      setExpanded(new Set([folders[0]]));
    }
  }, [folders, selectedFolder, selectedFile, selectFolder]);

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
            onSelect={() => {
              selectFolder(folder); // 单击即选中大表,视图跟随
              toggleExpand(folder);
            }}
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
  onSelect: () => void;
  onSelectFile: (file: string) => void;
}) {
  const { folder, expanded, selected, selectedFile, onSelect, onSelectFile } = props;
  const { data: files } = useApi<string[]>({ cmd: 'bigtable.sourceFiles', folder }, expanded);

  return (
    <li>
      <span className={`tree-folder ${selected ? 'selected' : ''}`} onClick={onSelect}>
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
