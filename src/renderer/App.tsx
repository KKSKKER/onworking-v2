// 应用外壳:多区域框架(VS Code 风格 dockview 视图区)+ 选中状态联动。
import { useMemo, useRef, useState } from 'react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { TopBar, type ShellMode } from './shell/TopBar';
import { SidebarLeft } from './shell/SidebarLeft';
import { SidebarRight } from './shell/SidebarRight';
import { CliOutputPanel } from './shell/CliOutputPanel';
import { ResizablePanel } from './shell/ResizableSidebar';
import { SelectionProvider } from './state/SelectionContext';
import { dockviewComponents, VIEWS } from './views/registry';
import './styles.css';

export function App() {
  const [mode, setMode] = useState<ShellMode>('files');
  const components = useMemo(() => dockviewComponents(), []);
  const apiRef = useRef<DockviewApi | null>(null);

  function onReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    const opened: string[] = [];
    for (const v of VIEWS) {
      event.api.addPanel({ id: v.id, component: v.id, title: v.title });
      opened.push(v.id);
    }
    void opened;
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
        <TopBar mode={mode} onModeChange={setMode} onAddView={addView} />
        <div className="body">
          <ResizablePanel axis="x" initial={240} min={140} max={500} dragEdge="right">
            <SidebarLeft mode={mode} />
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
