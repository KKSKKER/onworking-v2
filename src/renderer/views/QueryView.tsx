// 视图:查询。已保存查询管线的列表 + 运行/重算。
import { useState } from 'react';
import { useApi } from './useApi';
import { sendCli } from '../cli';

interface RunSummary {
  pipelineId: string;
  kind: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

export function QueryView() {
  const { data: pipelines, reload } = useApi<string[]>({ cmd: 'pipeline.list' });
  const [results, setResults] = useState<RunSummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function runAll() {
    setBusy(true);
    const res = await sendCli({ cmd: 'pipeline.recomputeAll' });
    if (res.ok) setResults(res.data as RunSummary[]);
    setBusy(false);
  }

  async function runOne(id: string) {
    setBusy(true);
    const res = await sendCli({ cmd: 'pipeline.run', id });
    if (res.ok) setResults([res.data as RunSummary]);
    setBusy(false);
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        <b>查询管理</b>(只管理已保存的管线){' '}
        <button onClick={runAll} disabled={busy}>
          {busy ? '运行中…' : '全部重算'}
        </button>{' '}
        <button onClick={reload}>刷新</button>
      </div>
      <table border={1} cellPadding={4} cellSpacing={0}>
        <thead>
          <tr>
            <th>管线</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(pipelines ?? []).map((id) => (
            <tr key={id}>
              <td>{id}</td>
              <td>
                <button onClick={() => runOne(id)}>运行</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {results && (
        <div style={{ marginTop: 12 }}>
          <b>结果:</b>
          {results.map((r) => (
            <div key={r.pipelineId}>
              {r.pipelineId}: {r.ok ? `OK ${r.rows} 行` : `失败 ${r.error}`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
