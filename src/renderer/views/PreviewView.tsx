// 视图:预览 —— 按选中对象切换:
//   选中大表  → bigtable.previewRows(展示大表 DB 数据)
//   选中源文件 → setup.preview(展示源文件内容;多 sheet 可下拉选 sheet,表头行可调)
// 统一分页(pageSize=100),选中切换自动加载;DataTable 单一滚动容器,横/纵向滚动条正常。
import { useEffect, useRef, useState } from 'react';
import { useSelection } from '../state/SelectionContext';
import { DataTable } from '../components/DataTable';
import { PaginationBar } from '../components/PaginationBar';
import { sendCli } from '../cli';
import { subscribeRefresh } from '../refresh';

interface PreviewData {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
}

const PAGE_SIZE = 100;

/** 表头去重:重复列名加后缀(其他 → 其他_2),避免预览时同名列互相覆盖(源文件常见重复表头)。 */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });
}

export function PreviewView() {
  const { selectedFolder, selectedFile } = useSelection();
  const [headerRow, setHeaderRow] = useState(1);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState('');
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  // 选中源文件/大表 → 自动加载预览(文件优先:选了文件显示文件,否则显示大表)
  useEffect(() => {
    setErr('');
    setPage(0);
    setPreview(null);
    if (selectedFile) {
      void loadFilePreview(selectedFile);
    } else if (selectedFolder) {
      setHeaderRow(1);
      setSheets([]);
      setSheet('');
      void loadBigTable(0, selectedFolder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder, selectedFile]);

  // 数据变化(跑管线/导入/删除等)→ 重新加载当前预览(用 ref 持有最新加载函数,避免反复订阅)
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => {
    setErr('');
    if (selectedFile) void loadSource(page, selectedFile, sheet);
    else if (selectedFolder) void loadBigTable(page, selectedFolder);
  };
  useEffect(() => subscribeRefresh(() => reloadRef.current()), []);

  async function loadBigTable(p: number, folder: string) {
    setBusy(true);
    const res = await sendCli({ cmd: 'bigtable.previewRows', folder, offset: p * PAGE_SIZE, limit: PAGE_SIZE });
    setBusy(false);
    if (!res.ok) { setErr(res.error.message); return; }
    const d = res.data as { columns: string[]; rows: Record<string, unknown>[]; total: number };
    setPreview({ title: `大表: ${folder}`, columns: d.columns, rows: d.rows, total: d.total });
  }

  // 预览源文件:若该大表已有规则,按规则的 sheetName + 表头行加载(与入库视角一致)
  async function loadFilePreview(filePath: string) {
    let ruleSheet = '';
    let ruleHeader = 1;
    if (selectedFolder) {
      const cfg = await sendCli({ cmd: 'bigtable.config', folder: selectedFolder });
      if (cfg.ok) {
        const ctx = cfg.data as { rules: { sources: { sheetName?: string; headerRow: number }[] }[] };
        const src = ctx.rules?.[0]?.sources?.[0];
        if (src) {
          ruleSheet = src.sheetName ?? '';
          ruleHeader = src.headerRow ?? 1;
        }
      }
    }
    setHeaderRow(ruleHeader);
    const res = await sendCli({ cmd: 'setup.sheets', filePath });
    const names = res.ok ? (res.data as string[]) : [];
    setSheets(names);
    const pick = ruleSheet && names.includes(ruleSheet) ? ruleSheet : (names[0] ?? '');
    setSheet(pick);
    void loadSource(0, filePath, pick);
  }

  async function loadSource(p: number, filePath: string, sheetName: string) {
    setBusy(true);
    const res = await sendCli({
      cmd: 'setup.preview',
      filePath,
      sheetName: sheetName || undefined,
      headerRow,
      offset: p * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    setBusy(false);
    if (!res.ok) { setErr(res.error.message); return; }
    const d = res.data as { sheetName?: string; headers: string[]; rows: unknown[][]; total: number };
    const cols = dedupeHeaders(d.headers); // 重复表头加后缀,避免同名列互相覆盖
    const rows = d.rows.map((r) => {
      const rec: Record<string, unknown> = {};
      cols.forEach((h, j) => { rec[h] = r[j]; });
      return rec;
    });
    setPreview({ title: `${fileNameOf(filePath)} · ${sheetName || d.sheetName || ''}`, columns: cols, rows, total: d.total });
  }

  function handlePageChange(p: number) {
    setPage(p);
    if (selectedFile) void loadSource(p, selectedFile, sheet);
    else if (selectedFolder) void loadBigTable(p, selectedFolder);
  }

  function handleHeaderRow(n: number) {
    setHeaderRow(n);
    if (selectedFile) void loadSource(0, selectedFile, sheet);
  }

  const fileNameOf = (p: string): string => p.split(/[\\/]/).pop() ?? p;
  const label = selectedFile
    ? `文件: ${fileNameOf(selectedFile)}`
    : selectedFolder
      ? `大表: ${selectedFolder}`
      : '(未选择)';

  // 导出 CSV:大表→bigtable.exportCsv;源文件→setup.exportCsv(同预览视角的 sheet+表头行)
  async function handleExport() {
    setExportMsg('');
    if (selectedFile) {
      const res = await sendCli({ cmd: 'setup.exportCsv', filePath: selectedFile, sheetName: sheet || undefined, headerRow });
      if (res.ok) {
        const d = res.data as { file: string; rows: number };
        setExportMsg(`已导出: ${d.file} (${d.rows} 行)`);
      } else setExportMsg(`导出失败: ${res.error.message}`);
    } else if (selectedFolder) {
      const res = await sendCli({ cmd: 'bigtable.exportCsv', folder: selectedFolder });
      if (res.ok) {
        const d = res.data as { file: string; rows: number };
        setExportMsg(`已导出: ${d.file} (${d.rows} 行)`);
      } else setExportMsg(`导出失败: ${res.error.message}`);
    } else {
      setExportMsg('请先选择大表或源文件');
    }
  }

  return (
    <div style={{ padding: 12, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>预览:</b> <span>{label}</span>
        {selectedFile && sheets.length > 0 && (
          <span>
            Sheet{' '}
            <select
              value={sheet}
              onChange={(e) => {
                setSheet(e.target.value);
                void loadSource(0, selectedFile, e.target.value);
              }}
              style={{ maxWidth: 220 }}
            >
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </span>
        )}
        {selectedFile && (
          <span>
            表头行{' '}
            <input
              type="number"
              value={headerRow}
              onChange={(e) => handleHeaderRow(Number(e.target.value))}
              style={{ width: 50 }}
            />
          </span>
        )}
        <button onClick={handleExport} disabled={!selectedFolder && !selectedFile}>
          导出 CSV
        </button>
        <span style={{ color: 'red' }}>{err}</span>
        {exportMsg && <span style={{ color: '#8b949e', fontSize: 11 }}>{exportMsg}</span>}
      </div>
      {preview ? (
        <>
          <PaginationBar page={page} pageSize={PAGE_SIZE} total={preview.total} onPageChange={handlePageChange} />
          <DataTable columns={preview.columns} rows={preview.rows} />
        </>
      ) : (
        <p style={{ color: '#8b949e' }}>
          {busy ? '加载中…' : '在左侧栏选择一个大表(预览其数据)或一个源文件(预览其内容)。'}
        </p>
      )}
    </div>
  );
}
