// 视图注册表:五视图注册进 dockview。
import type { FunctionComponent } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { BigTableSettingsView } from './BigTableSettingsView';
import { MappingView } from './MappingView';
import { PreviewView } from './PreviewView';
import { SqlView } from './SqlView';
import { QueryView } from './QueryView';

export interface ViewDef {
  id: string;
  title: string;
  component: FunctionComponent<IDockviewPanelProps>;
}

export const VIEWS: ViewDef[] = [
  { id: 'bigtable-settings', title: '大表字段设置', component: BigTableSettingsView },
  { id: 'mapping', title: '文件字段映射', component: MappingView },
  { id: 'preview', title: '预览', component: PreviewView },
  { id: 'sql', title: 'SQL 工作台', component: SqlView },
  { id: 'query', title: '查询', component: QueryView },
];

export function dockviewComponents(): Record<string, FunctionComponent<IDockviewPanelProps>> {
  const comps: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
  for (const v of VIEWS) comps[v.id] = v.component;
  return comps;
}
