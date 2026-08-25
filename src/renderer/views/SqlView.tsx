// 视图:SQL 工作台。表浏览器 + SQL 编辑器 + 真实查询执行(query.run)。
// 结果表用 DataTable(可拖列宽)+ PaginationBar(分页)。
import { useState } from 'react';
import { useApi } from './useApi';
import { DataTable } from '../components/DataTable';
import { PaginationBar } from '../components/PaginationBar';
import { sendCli } from '../cli';

interface TableInfo {
  name: string;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

const PAGE_SIZE = 100;

export function SqlView() {
  const { data: tables, reload } = useApi<TableInfo[]>({ cmd: 'schema.tables' });
  const [sql, setSql] = useState('SELECT date, debit FROM seq LIMIT 100');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleRun() {
    setErr('');
    setBusy(true);
    const res = await sendCli({ cmd: 'query.run', sql });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error.message);
      setResult(null);
      return;
    }
    setResult(res.data as QueryResult);
    setPage(0);
  }

  async function handleCopyStructure() {
    const res = await sendCli({ cmd: 'schema.tables' });
    if (res.ok) {
      const list = (res.data as TableInfo[]).map((t) => `表: ${t.name}`).join('\n');
      await navigator.clipboard?.writeText(list);
      setErr('表结构已复制');
    }
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 12, height: '100%' }}>
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace', boxSizing: 'border-box' }}
          />
          <div style={{ margin: '8px 0' }}>
            <button onClick={handleRun} disabled={busy}>
              {busy ? '运行中…' : '▶ 运行'}
            </button>{' '}
            <span style={{ color: 'red' }}>{err}</span>
          </div>
          {result && result.rows.length > 0 && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <PaginationBar page={page} pageSize={PAGE_SIZE} total={result.rowCount} onPageChange={setPage} />
              <div style={{ flex: 1, overflow: 'auto' }}>
                <DataTable
                  columns={result.columns}
                  rows={result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)}
                />
              </div>
            </div>
          )}
          {result && result.rows.length === 0 && <p style={{ color: '#8b949e' }}>查询成功,0 行结果。</p>}
        </div>
      </div>
    </div>
  );
}
