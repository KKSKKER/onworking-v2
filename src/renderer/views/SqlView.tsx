// 视图:SQL 工作台。表浏览器 + SQL 编辑器 + 运行结果。
import { useState } from 'react';
import { useApi } from './useApi';

interface TableInfo {
  name: string;
}

const SAMPLE_RESULT: Record<string, unknown>[] = [
  { date: '2024-01', total: 123456 },
  { date: '2024-02', total: 8200 },
];

export function SqlView() {
  const { data: tables } = useApi<TableInfo[]>({ cmd: 'schema.tables' });
  const [sql, setSql] = useState('SELECT date, SUM(debit) AS total FROM seq GROUP BY date');
  const [result, setResult] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState('');

  async function handleRun() {
    setErr('');
    // 演示:mock 环境直接返回样例(真实环境走查询管线)
    setResult(SAMPLE_RESULT);
  }

  function handleCopyStructure() {
    navigator.clipboard?.writeText(
      (tables ?? []).map((t) => `表 ${t.name} (SQLite)`).join('\n'),
    );
    setErr('表结构已复制(演示)');
  }

  const cols = result && result.length > 0 ? Object.keys(result[0]) : [];

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
        </div>
        <div style={{ flex: 1 }}>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
          <div style={{ margin: '8px 0' }}>
            <button onClick={handleRun}>▶ 运行 (Ctrl+Enter)</button>{' '}
            <span style={{ color: 'red' }}>{err}</span>
          </div>
          {result && (
            <table border={1} cellPadding={4} cellSpacing={0}>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c}>{String(r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
