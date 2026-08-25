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
        // 选文件不清大表:文件本来就属于某个大表,保留 folder 让映射/预览按大表上下文工作。
        // 预览视图按「文件优先」处理(选了文件显示文件,否则显示大表)。
        selectFile: (f) => setSelectedFile(f),
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
