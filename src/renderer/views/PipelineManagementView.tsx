// 视图:管线管理(原「查询」)—— 三大列:映射管线(clean)/清洗管线(sql-clean)/查询管线(query)。
// 每列 4 子列:管线名称 / 前置依赖(血缘) / 生成表 / 执行;列顶「全部执行」。
// 执行查询管线后弹出结果视图(Tab 名 = 结果表名)。数据来自 pipeline.configs,随工作区变化自动刷新。
import { useState } from 'react';
import type { PipelineConfig } from '../../core/pipeline/config';
import { useApi } from './useApi';
import { sendCli } from '../cli';
import { openQueryResult } from '../state/panel';

interface RunSummary {
  pipelineId: string;
  kind: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

type GroupKey = 'clean' | 'sql-clean' | 'query';
const GROUPS: { key: GroupKey; title: string }[] = [
  { key: 'clean', title: '映射管线' },
  { key: 'sql-clean', title: '清洗管线' },
  { key: 'query', title: '查询管线' },
];

function deps(p: PipelineConfig): string {
  if (p.kind === 'clean') return `源: ${p.sourceDir}`;
  if (p.kind === 'sql-clean') return `大表: ${p.bigTables.join(', ')}`;
  return p.dependencies.join(', ') || '-';
}
function gen(p: PipelineConfig): string {
  if (p.kind === 'clean') return `大表: ${p.bigTableFolder}`;
  return `表: ${p.resultTable}`;
}

function Column({ title, list, busy, results, onRun, onRunAll }: {
  title: string;
  list: PipelineConfig[];
  busy: boolean;
  results: Record<string, RunSummary>;
  onRun: (p: PipelineConfig) => void;
  onRunAll: () => void;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, border: '1px solid #e5e5e5', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b>
          {title} ({list.length})
        </b>
        <button onClick={onRunAll} disabled={busy || list.length === 0}>
          全部执行
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#666' }}>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>名称</th>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>前置依赖</th>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>生成</th>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>执行</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const r = results[p.id];
              return (
                <tr key={p.id} style={{ borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }}>
                  <td style={{ padding: '3px 4px', fontWeight: 600 }}>
                    {p.id}
                    {r && (
                      <span style={{ fontSize: 10, color: r.ok ? 'green' : 'red' }}>
                        {' '}
                        {r.ok ? `✓${r.rows ?? ''}` : '✗'}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '3px 4px', fontSize: 11, color: '#666', wordBreak: 'break-all' }}>{deps(p)}</td>
                  <td style={{ padding: '3px 4px', fontSize: 11 }}>{gen(p)}</td>
                  <td style={{ padding: '3px 4px' }}>
                    <button onClick={() => onRun(p)} disabled={busy}>
                      执行
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: '#8b949e', padding: 8, fontSize: 12 }}>
                  (无)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PipelineManagementView() {
  const { data: pipelines, reload } = useApi<PipelineConfig[]>({ cmd: 'pipeline.configs' });
  const [results, setResults] = useState<Record<string, RunSummary>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function runOne(p: PipelineConfig) {
    setBusy(true);
    setMsg('');
    const res = await sendCli({ cmd: 'pipeline.run', id: p.id });
    setBusy(false);
    const summary: RunSummary = res.ok
      ? (res.data as RunSummary)
      : { pipelineId: p.id, kind: p.kind, ok: false, error: res.error.message };
    setResults((r) => ({ ...r, [p.id]: summary }));
    // 查询管线执行成功后,弹出结果视图(Tab 名 = 结果表名)
    if (p.kind === 'query' && res.ok) {
      const qp = p as Extract<PipelineConfig, { kind: 'query' }>;
      openQueryResult({ tableName: qp.resultTable, sql: qp.sql });
    }
  }

  async function runAll(key: GroupKey) {
    const list = (pipelines ?? []).filter((p) => p.kind === key);
    if (list.length === 0) return;
    setBusy(true);
    setMsg('');
    const out: Record<string, RunSummary> = {};
    for (const p of list) {
      const res = await sendCli({ cmd: 'pipeline.run', id: p.id });
      out[p.id] = res.ok
        ? (res.data as RunSummary)
        : { pipelineId: p.id, kind: p.kind, ok: false, error: res.error.message };
    }
    setBusy(false);
    setResults((r) => ({ ...r, ...out }));
    setMsg(`已执行 ${GROUPS.find((g) => g.key === key)?.title ?? key} ${list.length} 条`);
  }

  return (
    <div style={{ padding: 12, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <b>管线管理</b> <button onClick={reload}>刷新</button>
        {msg && <span style={{ color: '#8b949e', fontSize: 11 }}>{msg}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12 }}>
        {GROUPS.map((g) => (
          <Column
            key={g.key}
            title={g.title}
            list={(pipelines ?? []).filter((p) => p.kind === g.key)}
            busy={busy}
            results={results}
            onRun={runOne}
            onRunAll={() => void runAll(g.key)}
          />
        ))}
      </div>
    </div>
  );
}
