// 应用外壳:多区域框架(VS Code 风格 dockview 视图区)+ 选中状态联动。
import { useMemo, useRef, useState } from 'react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { TopBar, type ShellMode } from './shell/TopBar';
import { SidebarLeft } from './shell/SidebarLeft';
import { SidebarRight } from './shell/SidebarRight';
import { BottomPanel } from './shell/BottomPanel';
import { ResizableSidebar } from './shell/ResizableSidebar';
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

  // 分栏:把「预览」视图分到当前视图右侧 → 两栏并排
  function splitView() {
    const api = apiRef.current;
    if (!api) return;
    const active = api.activePanel;
    if (!active) return;
    const existing = api.getPanel('preview');
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: 'preview',
      component: 'preview',
      title: '预览',
      position: { referencePanel: active.id, direction: 'right' },
    });
  }

  return (
    <SelectionProvider>
      <div className="app">
        <TopBar mode={mode} onModeChange={setMode} onAddView={addView} onSplitView={splitView} />
        <div className="body">
          <ResizableSidebar initialWidth={240} minWidth={140} maxWidth={500} side="left">
            <SidebarLeft mode={mode} />
          </ResizableSidebar>
          <main className="view-area">
            <DockviewReact
              className="dockview-theme-light"
              components={components}
              onReady={onReady}
            />
          </main>
          <ResizableSidebar initialWidth={220} minWidth={140} maxWidth={500} side="right">
            <SidebarRight />
          </ResizableSidebar>
        </div>
        <BottomPanel />
      </div>
    </SelectionProvider>
  );
}
