// 选中状态:侧边栏选中大表/文件 → 视图跟随切换(参考 V1 BigTableStore 的跨视图共享)。
import { createContext, useContext, useState, type ReactNode } from 'react';

export interface SelectionValue {
  selectedFolder: string | null;
  selectedFile: string | null;
  selectFolder: (folder: string | null) => void;
  selectFile: (file: string | null) => void;
}

const SelectionContext = createContext<SelectionValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  return (
    <SelectionContext.Provider
      value={{
        selectedFolder,
        selectedFile,
        selectFolder: (f) => {
          setSelectedFolder(f);
          if (f) setSelectedFile(null); // 切大表时清掉文件选择
        },
        selectFile: (f) => {
          setSelectedFile(f);
          if (f) setSelectedFolder(null); // 切文件时清掉大表选择(否则预览/详情会优先显示大表)
        },
      }}
    >
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection(): SelectionValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within SelectionProvider');
  return ctx;
}
