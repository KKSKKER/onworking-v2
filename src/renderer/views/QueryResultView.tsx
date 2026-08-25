// 视图:查询结果弹窗 —— 执行查询管线后弹出,Tab 名 = 结果表名。
// 复用预览的格式:DataTable(上下左右滚动)+ 分页 + CSV 导出(query.exportCsv)。无表头行概念。
import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { DataTable } from '../components/DataTable';
import { PaginationBar } from '../components/PaginationBar';
import { sendCli } from '../cli';

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

const PAGE_SIZE = 100;

function quoteTable(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function QueryResultView({ params }: IDockviewPanelProps) {
  const { tableName, sql } = (params ?? {}) as { tableName: string; sql?: string };
  const runSql = sql ?? `SELECT * FROM ${quoteTable(tableName)} LIMIT 500`;
  const [result, setResult] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  useEffect(() => {
    setErr('');
    setExportMsg('');
    setResult(null);
    setPage(0);
    setBusy(true);
    let alive = true;
    void sendCli({ cmd: 'query.run', sql: runSql }).then((res) => {
      if (!alive) return;
      setBusy(false);
      if (res.ok) setResult(res.data as QueryResult);
      else setErr(res.error.message);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSql]);

  async function handleExport() {
    setExportMsg('');
    const res = await sendCli({ cmd: 'query.exportCsv', sql: runSql });
    if (res.ok) {
      const d = res.data as { file: string; rows: number };
      setExportMsg(`已导出: ${d.file} (${d.rows} 行)`);
    } else setExportMsg(`导出失败: ${res.error.message}`);
  }

  return (
    <div style={{ padding: 12, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>查询结果:</b> <span>{tableName}</span>
        <button onClick={handleExport}>导出 CSV</button>
        {exportMsg && <span style={{ color: '#8b949e', fontSize: 11 }}>{exportMsg}</span>}
        <span style={{ color: 'red' }}>{err}</span>
      </div>
      {result && result.rows.length > 0 && (
        <>
          <PaginationBar page={page} pageSize={PAGE_SIZE} total={result.rowCount} onPageChange={setPage} />
          <DataTable
            columns={result.columns}
            rows={result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)}
          />
        </>
      )}
      {result && result.rows.length === 0 && <p style={{ color: '#8b949e' }}>查询成功,0 行结果。</p>}
      {!result && !err && <p style={{ color: '#8b949e' }}>{busy ? '查询中…' : '加载…'}</p>}
    </div>
  );
}
