// 应用外壳:多区域框架(VS Code 风格 dockview 视图区)+ 选中状态联动。
import { useMemo, useRef } from 'react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { TopBar } from './shell/TopBar';
import { SidebarLeft } from './shell/SidebarLeft';
import { SidebarRight } from './shell/SidebarRight';
import { CliOutputPanel } from './shell/CliOutputPanel';
import { ResizablePanel } from './shell/ResizableSidebar';
import { SelectionProvider } from './state/SelectionContext';
import { setOpenQueryResult } from './state/panel';
import { dockviewComponents, VIEWS } from './views/registry';
import './styles.css';

export function App() {
  const components = useMemo(() => dockviewComponents(), []);
  const apiRef = useRef<DockviewApi | null>(null);

  function onReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    for (const v of VIEWS) {
      event.api.addPanel({ id: v.id, component: v.id, title: v.title });
    }
    // 查询结果弹窗:管线管理执行查询管线时打开一个 Tab(名称 = 结果表名)
    setOpenQueryResult(({ tableName, sql }) => {
      const api = apiRef.current;
      if (!api) return;
      const id = `query-result-${tableName}`;
      if (api.getPanel(id)) {
        api.getPanel(id)?.api.setActive();
      } else {
        api.addPanel({ id, component: 'query-result', title: tableName, params: { tableName, sql } });
      }
    });
  }

  function addView(viewId: string) {
    const api = apiRef.current;
    if (!api) return;
    if (api.getPanel(viewId)) {
      api.getPanel(viewId)?.api.setActive();
    } else {
      const v = VIEWS.find((x) => x.id === viewId);
      api.addPanel({ id: viewId, component: viewId, title: v?.title ?? viewId });
    }
  }

  return (
    <SelectionProvider>
      <div className="app">
        <TopBar onAddView={addView} />
        <div className="body">
          <ResizablePanel axis="x" initial={240} min={140} max={500} dragEdge="right">
            <SidebarLeft />
          </ResizablePanel>
          <main className="view-area">
            <DockviewReact
              className="dockview-theme-light"
              components={components}
              onReady={onReady}
            />
          </main>
          <ResizablePanel axis="x" initial={220} min={140} max={500} dragEdge="left">
            <SidebarRight />
          </ResizablePanel>
        </div>
        <ResizablePanel axis="y" initial={130} min={60} max={400} dragEdge="top">
          <CliOutputPanel />
        </ResizablePanel>
      </div>
    </SelectionProvider>
  );
}
