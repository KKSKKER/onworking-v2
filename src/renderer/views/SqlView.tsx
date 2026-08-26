// 视图:SQL 工作台。侧边显示表结构(点表自动填充 SELECT),SQL 编辑器 + 真实查询(query.run,不限行),
// 可导出 CSV(query.exportCsv)。结果表用 DataTable(可拖列宽,上下左右滚动)+ PaginationBar(分页)。
import { useEffect, useState } from 'react';
import { useApi } from './useApi';
import { useSelection } from '../state/SelectionContext';
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
  changes?: number;
  lastInsertRowid?: number | bigint;
}

/** 判断语句是否写(非 SELECT/WITH 开头视为写)。 */
function isWriteSql(sql: string): boolean {
  return !/^\s*(SELECT|WITH)\b/i.test(sql);
}

const PAGE_SIZE = 100;

/** 表名安全引用:纯标识符直接裸写,否则加双引号。 */
function quoteTable(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function SqlView() {
  const { selectedFolder } = useSelection();
  // 操作源:'master' = 总表 DB;否则为大表 folder 的 DB
  const [dbSource, setDbSource] = useState<'master' | string>('master');
  // 选中大表时默认切到该大表 DB(总表 DB 需点按钮切换)
  useEffect(() => {
    if (selectedFolder) setDbSource(selectedFolder);
  }, [selectedFolder]);
  const { data: tables, reload } = useApi<TableInfo[]>(
    dbSource === 'master' ? { cmd: 'schema.tables' } : { cmd: 'schema.tables', folder: dbSource },
  );
  const [sql, setSql] = useState('SELECT date, debit FROM seq LIMIT 100');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  // 建管线弹窗:sql-clean(清洗) / query(查询)
  const [createKind, setCreateKind] = useState<'sql-clean' | 'query' | null>(null);
  const [pId, setPId] = useState('');
  const [pResult, setPResult] = useState('');
  const [pList, setPList] = useState('');
  const [createMsg, setCreateMsg] = useState('');

  async function handleRun() {
    setErr('');
    setExportMsg('');
    const dbLabel = dbSource === 'master' ? '总表 master.db' : `大表 ${dbSource}`;
    if (isWriteSql(sql) && !window.confirm(`当前是写语句(会直接修改${dbLabel}),确定执行?`)) return;
    setBusy(true);
    const res = await sendCli(dbSource === 'master' ? { cmd: 'query.run', sql } : { cmd: 'query.run', sql, folder: dbSource });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error.message);
      setResult(null);
      return;
    }
    setResult(res.data as QueryResult);
    setPage(0);
    reload(); // 运行后刷新表列表(DROP/CREATE 等写语句后侧边栏即时更新)
  }

  // 点表自动填充一条 SELECT(模仿编辑器补全)
  function handleTableClick(name: string) {
    setSql(`SELECT * FROM ${quoteTable(name)} LIMIT 100`);
    setErr('');
  }

  async function handleExport() {
    setExportMsg('');
    setBusy(true);
    const res = await sendCli(dbSource === 'master' ? { cmd: 'query.exportCsv', sql } : { cmd: 'query.exportCsv', sql, folder: dbSource });
    setBusy(false);
    if (res.ok) setExportMsg(`已导出: ${(res.data as { file: string; rows: number }).file} (${(res.data as { rows: number }).rows} 行)`);
    else setExportMsg(`导出失败: ${res.error.message}`);
  }

  function openCreate(kind: 'sql-clean' | 'query') {
    setCreateKind(kind);
    setCreateMsg('');
  }

  async function confirmCreate() {
    if (!createKind) return;
    const id = pId.trim();
    const resultTable = pResult.trim();
    const list = pList.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!id) { setCreateMsg('管线 id 必填'); return; }
    if (!resultTable) { setCreateMsg('结果表名必填'); return; }
    if (createKind === 'sql-clean' && list.length === 0) { setCreateMsg('至少要填一个参与大表'); return; }
    const now = new Date().toISOString();
    const config = createKind === 'sql-clean'
      ? { kind: 'sql-clean' as const, id, label: id, bigTables: list, sql, resultTable, createdAt: now }
      : { kind: 'query' as const, id, label: id, sql, dependencies: list, resultTable, createdAt: now };
    setCreateMsg('');
    const res = await sendCli({ cmd: 'pipeline.save', config });
    if (!res.ok) { setCreateMsg(`创建失败: ${res.error.message}`); return; }
    setCreateMsg(`已创建${createKind === 'sql-clean' ? '清洗' : '查询'}管线「${id}」`);
    setCreateKind(null);
    setPId(''); setPResult(''); setPList('');
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
            <span style={{ fontSize: 11, color: '#57606a' }}>
              {dbSource === 'master' ? '(总表)' : `(大表 ${dbSource})`}
            </span>{' '}
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
            <button onClick={() => openCreate('sql-clean')} disabled={busy} title="把当前 SQL 存成清洗管线(大表→总表)">
              存为清洗管线
            </button>{' '}
            <button onClick={() => openCreate('query')} disabled={busy} title="把当前 SQL 存成查询管线(物化结果表)">
              存为查询管线
            </button>{' '}
            {selectedFolder && (
              <button onClick={() => setDbSource(dbSource === 'master' ? selectedFolder : 'master')} disabled={busy} title="切换 SQL 操作的 DB 源">
                {dbSource === 'master' ? `对「${selectedFolder}」大表操作` : '对总表操作'}
              </button>
            )}{' '}
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
          {result && result.rows.length === 0 && (
            <p style={{ color: '#8b949e' }}>
              {result.changes !== undefined
                ? `执行成功,影响 ${result.changes} 行${result.lastInsertRowid !== undefined ? `, lastInsertRowid=${String(result.lastInsertRowid)}` : ''}。`
                : '查询成功,0 行结果。'}
            </p>
          )}
        </div>
      </div>

      {createKind && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setCreateKind(null)}
        >
          <div
            style={{ background: '#fff', border: '1px solid #d0d7de', borderRadius: 8, padding: 16, width: 380, boxShadow: '0 8px 24px rgba(0,0,0,.15)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <b>{createKind === 'sql-clean' ? '存为清洗管线(大表→总表)' : '存为查询管线(物化结果表)'}</b>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <label>
                管线 id{' '}
                <input value={pId} onChange={(e) => setPId(e.target.value)} placeholder={createKind === 'sql-clean' ? '如 s1' : '如 q1'} />
              </label>
              <label>
                结果表名{' '}
                <input value={pResult} onChange={(e) => setPResult(e.target.value)} placeholder="生成到总库的表名" />
              </label>
              {createKind === 'sql-clean' ? (
                <label>
                  参与大表(逗号分隔){' '}
                  <input value={pList} onChange={(e) => setPList(e.target.value)} placeholder="如 序时账, 科目余额" />
                </label>
              ) : (
                <label>
                  依赖表名(逗号分隔,可选){' '}
                  <input value={pList} onChange={(e) => setPList(e.target.value)} placeholder="如 seq, balance" />
                </label>
              )}
              <div>SQL:</div>
              <pre style={{ maxHeight: 120, overflow: 'auto', background: '#f6f8fa', padding: 8, fontSize: 11, margin: 0 }}>{sql}</pre>
              {createMsg && <div style={{ color: 'red', fontSize: 12 }}>{createMsg}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setCreateKind(null)}>取消</button>
                <button onClick={() => void confirmCreate()}>确定创建</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
