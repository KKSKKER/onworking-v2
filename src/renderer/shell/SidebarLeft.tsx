// 左侧栏:大表树(单击=选中+展开;每行可导入文件;右键删除大表/源文件)。查询管理模式已移除。
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useApi } from '../views/useApi';
import { useSelection } from '../state/SelectionContext';
import { sendCli } from '../cli';
import { ContextMenu, menuAt, type ContextMenuState } from '../components/ContextMenu';
import type { BigTableConfig } from '../../core/bigtable/schema';
import { patternToRegex } from '../../core/glob';

interface AddFilesResult {
  added: string[];
  overwritten: string[];
  skipped: string[];
}

export function SidebarLeft() {
  return <BigTableTree />;
}

function BigTableTree() {
  const { data: folders, reload } = useApi<string[]>({ cmd: 'bigtable.list' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { selectedFolder, selectedFile, selectFolder, selectFile } = useSelection();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

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

  async function createBigTable() {
    const name = newName.trim();
    if (!name) return;
    const res = await sendCli({
      cmd: 'bigtable.save',
      folder: name,
      config: { tableName: name, autoIncrement: true, fields: [] } as BigTableConfig,
    });
    if (!res.ok) { setMsg(`新建失败: ${res.error.message}`); return; }
    setAdding(false);
    setNewName('');
    setMsg(`已新建大表「${name}」`);
    selectFolder(name);
    reload();
  }

  async function importFiles(folder: string) {
    const files = await window.onw.pickFiles();
    if (!files || files.length === 0) return;
    const res = await sendCli({ cmd: 'bigtable.addFiles', folder, files });
    if (!res.ok) { setMsg(`导入失败: ${res.error.message}`); return; }
    const r = res.data as AddFilesResult;
    if (r.skipped.length > 0) {
      const go = window.confirm(`以下文件已存在,是否覆盖?\n${r.skipped.join('\n')}`);
      if (go) {
        await sendCli({ cmd: 'bigtable.addFiles', folder, files, overwrite: true });
        setMsg(`已覆盖导入 ${files.length} 个文件`);
        setExpanded((p) => new Set(p).add(folder));
        reload();
        return;
      }
    }
    setMsg(`导入完成: 新增 ${r.added.length}, 覆盖 ${r.overwritten.length}${r.skipped.length ? `, 跳过 ${r.skipped.length}` : ''}`);
    setExpanded((p) => new Set(p).add(folder));
    reload();
  }

  async function deleteBigTable(folder: string) {
    if (!window.confirm(`确定删除大表「${folder}」?会删除整个大表文件夹(含规则/数据),不可恢复。`)) return;
    const res = await sendCli({ cmd: 'bigtable.delete', folder });
    if (!res.ok) { setMsg(`删除失败: ${res.error.message}`); return; }
    if (selectedFolder === folder) selectFolder(null);
    setMsg(`已删除大表「${folder}」`);
    reload();
  }

  async function deleteSourceFile(folder: string, file: string) {
    const name = file.split(/[\\/]/).pop() ?? file;
    if (!window.confirm(`确定删除源文件「${name}」?`)) return;
    const res = await sendCli({ cmd: 'bigtable.deleteSourceFile', folder, file: name });
    if (!res.ok) { setMsg(`删除失败: ${res.error.message}`); return; }
    setMsg(`已删除源文件「${name}」`);
    reload();
  }

  function onFolderCtx(e: MouseEvent, folder: string) {
    e.preventDefault();
    setMenu(menuAt(e, [{ label: `删除大表「${folder}」`, danger: true, onClick: () => void deleteBigTable(folder) }]));
  }

  function onFileCtx(e: MouseEvent, folder: string, file: string) {
    e.preventDefault();
    setMenu(menuAt(e, [{ label: `删除源文件「${file.split(/[\\/]/).pop() ?? file}」`, danger: true, onClick: () => void deleteSourceFile(folder, file) }]));
  }

  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">
        📁 大表 <button onClick={reload}>刷新</button>
      </div>
      {msg && <div className="sidebar-msg">{msg}</div>}
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
            onImport={() => void importFiles(folder)}
            onFolderCtx={onFolderCtx}
            onFileCtx={onFileCtx}
          />
        ))}
        {adding && (
          <li className="add-form">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="大表文件夹名"
              onKeyDown={(e) => { if (e.key === 'Enter') void createBigTable(); }}
            />
            <button onClick={() => void createBigTable()}>确定</button>
            <button onClick={() => { setAdding(false); setNewName(''); }}>取消</button>
          </li>
        )}
        <li className="add" onClick={() => setAdding(true)}>+ 新建大表</li>
      </ul>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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
  onImport: () => void;
  onFolderCtx: (e: MouseEvent, folder: string) => void;
  onFileCtx: (e: MouseEvent, folder: string, file: string) => void;
}) {
  const { folder, expanded, selected, selectedFile, onSelect, onSelectFile, onImport, onFolderCtx, onFileCtx } = props;
  const { data: files } = useApi<string[]>({ cmd: 'bigtable.sourceFiles', folder }, expanded);
  // 规则:判断哪些源文件已有映射(pattern 命中即视为已映射)
  const { data: rulesCtx } = useApi<{ rules: { sources: { pattern: string }[] }[] } | null>(
    expanded ? { cmd: 'bigtable.config', folder } : { cmd: 'bigtable.list' },
    expanded,
  );
  const mappedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const rule of rulesCtx?.rules ?? []) {
      for (const s of rule.sources) {
        const re = patternToRegex(s.pattern);
        for (const f of files ?? []) {
          if (re.test(f) || re.test(f.split(/[\\/]/).pop() ?? f)) set.add(f);
        }
      }
    }
    return set;
  }, [rulesCtx, files]);

  return (
    <li>
      <span
        className={`tree-folder ${selected ? 'selected' : ''}`}
        onClick={onSelect}
        onContextMenu={(e) => onFolderCtx(e, folder)}
      >
        <span className="tree-caret">{expanded ? '▾' : '▸'}</span> 🗂 {folder}
        <span
          className="tree-import"
          title="导入源文件"
          onClick={(e) => { e.stopPropagation(); onImport(); }}
        >
          📥
        </span>
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
                onContextMenu={(e) => onFileCtx(e, folder, file)}
                title={mappedFiles.has(file) ? '已有映射规则' : '无映射规则'}
              >
                {mappedFiles.has(file) ? <span className="tree-mapped">✓ </span> : null}📄 {name}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
