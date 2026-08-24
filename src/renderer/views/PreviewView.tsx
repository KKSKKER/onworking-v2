// 视图:预览。真实读取源文件数据(setup.preview,服务端分页),表头行可调。
// 结果表用 DataTable(可拖列宽)+ PaginationBar(分页)。
import { useState } from 'react';
import { useSelection } from '../state/SelectionContext';
import { DataTable } from '../components/DataTable';
import { PaginationBar } from '../components/PaginationBar';

interface PreviewData {
  sheetName: string;
  headerRow: number;
  headers: string[];
  rows: unknown[][];
  total: number;
}

const PAGE_SIZE = 100;

export function PreviewView() {
  const { selectedFile } = useSelection();
  const [headerRow, setHeaderRow] = useState(1);
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadPage(p: number) {
    if (!selectedFile) return;
    setBusy(true);
    const res = await window.onw.invoke({
      cmd: 'setup.preview',
      filePath: selectedFile,
      headerRow,
      offset: p * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error.message);
      return;
    }
    setPreview(res.data as PreviewData);
  }

  async function handleLoad() {
    setErr('');
    if (!selectedFile) {
      setErr('请先在左侧栏选择源文件');
      return;
    }
    setPage(0);
    await loadPage(0);
  }

  function handlePageChange(p: number) {
    setPage(p);
    void loadPage(p);
  }

  const fileName = selectedFile ? selectedFile.split(/[\\/]/).pop() : '(未选择)';
  const rowsAsRecords: Record<string, unknown>[] = (preview?.rows ?? []).map((r) => {
    const rec: Record<string, unknown> = {};
    preview!.headers.forEach((h, j) => {
      rec[h] = r[j];
    });
    return rec;
  });

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          文件: <b>{fileName}</b>
        </span>
        <span>
          表头行{' '}
          <input
            type="number"
            value={headerRow}
            onChange={(e) => setHeaderRow(Number(e.target.value))}
            style={{ width: 50 }}
          />
        </span>
        <button onClick={handleLoad} disabled={busy}>
          {busy ? '加载中…' : '加载预览'}
        </button>
        <span style={{ color: 'red' }}>{err}</span>
      </div>
      {preview ? (
        <div style={{ height: 'calc(100% - 40px)', display: 'flex', flexDirection: 'column' }}>
          <PaginationBar page={page} pageSize={PAGE_SIZE} total={preview.total} onPageChange={handlePageChange} />
          <div style={{ flex: 1, overflow: 'auto' }}>
            <DataTable columns={preview.headers} rows={rowsAsRecords} />
          </div>
        </div>
      ) : (
        <p style={{ color: '#8b949e' }}>在左侧栏选择源文件后点击「加载预览」,查看真实数据。</p>
      )}
    </div>
  );
}
