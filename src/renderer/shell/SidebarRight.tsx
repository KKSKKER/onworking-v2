// 右侧栏:属性 / 上下文面板(选中大表/文件时显示对应信息)。
import { useSelection } from '../state/SelectionContext';

export function SidebarRight() {
  const { selectedFolder, selectedFile } = useSelection();
  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">属性 / 上下文</div>
      <div className="prop-row">
        <span className="prop-key">当前大表</span>
        <span className="prop-val">{selectedFolder ?? '(未选择)'}</span>
      </div>
      <div className="prop-row">
        <span className="prop-key">当前文件</span>
        <span className="prop-val">{selectedFile ? selectedFile.split(/[\\/]/).pop() : '(未选择)'}</span>
      </div>
      <div className="prop-hint">在左侧栏选择大表或文件,视图会跟随切换。</div>
    </div>
  );
}
