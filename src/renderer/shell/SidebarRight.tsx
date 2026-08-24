// 右侧栏:对象感知属性面板(选中大表/管线时显示对应信息)。
import { useApi } from '../views/useApi';

export function SidebarRight() {
  const { data: summary } = useApi<string>({ cmd: 'state.summary' });
  return (
    <div className="sidebar-panel">
      <div className="sidebar-title">属性 / 状态</div>
      <pre className="summary">{summary ?? '加载中…'}</pre>
    </div>
  );
}
