// 应用外壳:多区域框架(VS Code 风格 dockview 视图区)。
import { useMemo, useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { TopBar, type ShellMode } from './shell/TopBar';
import { SidebarLeft } from './shell/SidebarLeft';
import { SidebarRight } from './shell/SidebarRight';
import { BottomPanel } from './shell/BottomPanel';
import { dockviewComponents } from './views/registry';
import './styles.css';

export function App() {
  const [mode, setMode] = useState<ShellMode>('files');
  const components = useMemo(() => dockviewComponents(), []);

  function onReady(event: DockviewReadyEvent) {
    event.api.addPanel({ id: 'sql', component: 'sql', title: 'SQL 工作台' });
    event.api.addPanel({ id: 'query', component: 'query', title: '查询' });
    event.api.addPanel({ id: 'mapping', component: 'mapping', title: '文件字段映射' });
    event.api.addPanel({ id: 'bigtable-settings', component: 'bigtable-settings', title: '大表字段设置' });
    event.api.addPanel({ id: 'preview', component: 'preview', title: '预览' });
  }

  return (
    <div className="app">
      <TopBar mode={mode} onModeChange={setMode} />
      <div className="body">
        <aside className="sidebar-left">
          <SidebarLeft mode={mode} />
        </aside>
        <main className="view-area">
          <DockviewReact components={components} onReady={onReady} />
        </main>
        <aside className="sidebar-right">
          <SidebarRight />
        </aside>
      </div>
      <BottomPanel />
    </div>
  );
}
