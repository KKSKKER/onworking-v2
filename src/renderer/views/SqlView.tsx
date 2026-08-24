// 视图:SQL 工作台。表浏览器 + SQL 编辑器 + 真实查询执行(query.run)。
import { useState } from 'react';
import { useApi } from './useApi';

interface TableInfo {
  name: string;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export function SqlView() {
  const { data: tables, reload } = useApi<TableInfo[]>({ cmd: 'schema.tables' });
  const [sql, setSql] = useState('SELECT date, debit FROM seq LIMIT 100');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleRun() {
    setErr('');
    setBusy(true);
    const res = await window.onw.invoke({ cmd: 'query.run', sql });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error.message);
      setResult(null);
      return;
    }
    setResult(res.data as QueryResult);
  }

  async function handleCopyStructure() {
    const res = await window.onw.invoke({ cmd: 'schema.tables' });
    if (res.ok) {
      const list = (res.data as TableInfo[]).map((t) => `表: ${t.name}`).join('\n');
      await navigator.clipboard?.writeText(list);
      setErr('表结构已复制');
    }
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ minWidth: 160 }}>
          <b>🗂 表</b>
          <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
            {(tables ?? []).map((t) => (
              <li key={t.name}>{t.name}</li>
            ))}
          </ul>
          <button onClick={handleCopyStructure}>复制表结构</button>
          <button onClick={reload}>刷新</button>
        </div>
        <div style={{ flex: 1 }}>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
          <div style={{ margin: '8px 0' }}>
            <button onClick={handleRun} disabled={busy}>
              {busy ? '运行中…' : '▶ 运行'}
            </button>{' '}
            <span style={{ color: 'red' }}>{err}</span>
          </div>
          {result && (
            <div>
              <p style={{ color: '#57606a' }}>共 {result.rowCount} 行</p>
              <table border={1} cellPadding={4} cellSpacing={0}>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      {result.columns.map((c) => (
                        <td key={c}>{String(r[c] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
