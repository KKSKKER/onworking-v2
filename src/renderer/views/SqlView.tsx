// 视图:SQL 工作台。侧边显示表结构(点表自动填充 SELECT),SQL 编辑器 + 真实查询(query.run,不限行),
// 可导出 CSV(query.exportCsv)。结果表用 DataTable(可拖列宽,上下左右滚动)+ PaginationBar(分页)。
import { useState } from 'react';
import { useApi } from './useApi';
import { DataTable } from '../components/DataTable';
import { PaginationBar } from '../components/PaginationBar';
import { sendCli } from '../cli';

interface TableInfo {
  name: string;
  columns: { name: string; type: string }[];
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

const PAGE_SIZE = 100;

/** 表名安全引用:纯标识符直接裸写,否则加双引号。 */
function quoteTable(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function SqlView() {
  const { data: tables, reload } = useApi<TableInfo[]>({ cmd: 'schema.tables' });
  const [sql, setSql] = useState('SELECT date, debit FROM seq LIMIT 100');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  async function handleRun() {
    setErr('');
    setExportMsg('');
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

  // 点表自动填充一条 SELECT(模仿编辑器补全)
  function handleTableClick(name: string) {
    setSql(`SELECT * FROM ${quoteTable(name)} LIMIT 100`);
    setErr('');
  }

  async function handleExport() {
    setExportMsg('');
    setBusy(true);
    const res = await sendCli({ cmd: 'query.exportCsv', sql });
    setBusy(false);
    if (res.ok) setExportMsg(`已导出: ${(res.data as { file: string; rows: number }).file} (${(res.data as { rows: number }).rows} 行)`);
    else setExportMsg(`导出失败: ${res.error.message}`);
  }

  async function handleCopyStructure() {
    const list = (tables ?? []).map((t) => `表: ${t.name}\n  ${t.columns.map((c) => `${c.name}:${c.type}`).join(', ')}`).join('\n');
    await navigator.clipboard?.writeText(list);
    setErr('表结构已复制');
  }

  return (
    <div style={{ padding: 12, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 12, height: '100%' }}>
        <div style={{ minWidth: 200, overflow: 'auto' }}>
          <div style={{ marginBottom: 8 }}>
            <b>🗂 表</b>{' '}
            <button onClick={handleCopyStructure}>复制字段</button>{' '}
            <button onClick={reload}>刷新</button>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(tables ?? []).map((t) => (
              <li key={t.name} style={{ marginBottom: 8 }}>
                <span
                  onClick={() => handleTableClick(t.name)}
                  style={{ cursor: 'pointer', fontWeight: 600 }}
                  title="点击填充 SELECT *"
                >
                  {t.name}
                </span>
                {/* 字段竖排,放在限高小框内,超长可往下拉 */}
                <div
                  style={{
                    marginTop: 2,
                    maxHeight: 120,
                    overflowY: 'auto',
                    border: '1px solid #e5e5e5',
                    borderRadius: 4,
                    padding: '2px 6px',
                    background: '#fafafa',
                    fontSize: 11,
                    color: '#555',
                  }}
                >
                  {t.columns.length > 0
                    ? t.columns.map((c, i) => (
                        <div key={i} style={{ whiteSpace: 'nowrap' }}>
                          {c.name}:{c.type}
                        </div>
                      ))
                    : <div style={{ color: '#8b949e' }}>(空)</div>}
                </div>
              </li>
            ))}
          </ul>
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
            <button onClick={handleExport} disabled={busy}>
              导出 CSV
            </button>{' '}
            <span style={{ color: 'red' }}>{err}</span>
            {exportMsg && <span style={{ color: '#8b949e', fontSize: 11 }}>{exportMsg}</span>}
          </div>
          {result && result.rows.length > 0 && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <PaginationBar page={page} pageSize={PAGE_SIZE} total={result.rowCount} onPageChange={setPage} />
              <DataTable
                columns={result.columns}
                rows={result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)}
              />
            </div>
          )}
          {result && result.rows.length === 0 && <p style={{ color: '#8b949e' }}>查询成功,0 行结果。</p>}
        </div>
      </div>
    </div>
  );
}
