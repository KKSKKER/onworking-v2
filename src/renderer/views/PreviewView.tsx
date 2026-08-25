// 视图:预览 —— 按选中对象切换:
//   选中大表  → bigtable.previewRows(展示大表 DB 数据)
//   选中源文件 → setup.preview(展示源文件内容;多 sheet 可下拉选 sheet,表头行可调)
// 统一分页(pageSize=100),选中切换自动加载;DataTable 单一滚动容器,横/纵向滚动条正常。
import { useEffect, useState } from 'react';
import { useSelection } from '../state/SelectionContext';
import { DataTable } from '../components/DataTable';
import { PaginationBar } from '../components/PaginationBar';
import { sendCli } from '../cli';

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

  // 选中源文件/大表 → 自动加载预览(文件优先:选了文件显示文件,否则显示大表)
  useEffect(() => {
    setErr('');
    setPage(0);
    setPreview(null);
    if (selectedFile) {
      void loadSheets(selectedFile);
    } else if (selectedFolder) {
      setHeaderRow(1);
      setSheets([]);
      setSheet('');
      void loadBigTable(0, selectedFolder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder, selectedFile]);

  async function loadBigTable(p: number, folder: string) {
    setBusy(true);
    const res = await sendCli({ cmd: 'bigtable.previewRows', folder, offset: p * PAGE_SIZE, limit: PAGE_SIZE });
    setBusy(false);
    if (!res.ok) { setErr(res.error.message); return; }
    const d = res.data as { columns: string[]; rows: Record<string, unknown>[]; total: number };
    setPreview({ title: `大表: ${folder}`, columns: d.columns, rows: d.rows, total: d.total });
  }

  async function loadSheets(filePath: string) {
    const res = await sendCli({ cmd: 'setup.sheets', filePath });
    const names = res.ok ? (res.data as string[]) : [];
    setSheets(names);
    const first = names[0] ?? '';
    setSheet(first);
    void loadSource(0, filePath, first);
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
        <span style={{ color: 'red' }}>{err}</span>
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
