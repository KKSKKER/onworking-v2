// 视图:预览。真实读取源文件数据(setup.preview),表头行/截止行可调。
import { useState } from 'react';
import { useSelection } from '../state/SelectionContext';

interface PreviewData {
  sheetName: string;
  headerRow: number;
  headers: string[];
  rows: unknown[][];
  total: number;
}

export function PreviewView() {
  const { selectedFile } = useSelection();
  const [headerRow, setHeaderRow] = useState(1);
  const [limit, setLimit] = useState(100);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleLoad() {
    setErr('');
    if (!selectedFile) {
      setErr('请先在左侧栏选择源文件');
      return;
    }
    setBusy(true);
    const res = await window.onw.invoke({
      cmd: 'setup.preview',
      filePath: selectedFile,
      headerRow,
      limit,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error.message);
      setPreview(null);
      return;
    }
    setPreview(res.data as PreviewData);
  }

  const fileName = selectedFile ? selectedFile.split(/[\\/]/).pop() : '(未选择)';

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          文件: <b>{fileName}</b>
        </span>
        <span>
          Sheet:{' '}
          <select value={preview?.sheetName ?? ''} disabled={!preview}>
            <option>{preview?.sheetName ?? '—'}</option>
          </select>
        </span>
        <span>
          表头行{' '}
          <input type="number" value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))} style={{ width: 50 }} />
        </span>
        <span>
          行数{' '}
          <input type="number" value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ width: 60 }} />
        </span>
        <button onClick={handleLoad} disabled={busy}>
          {busy ? '加载中…' : '加载预览'}
        </button>
        <span style={{ color: 'red' }}>{err}</span>
      </div>
      {preview ? (
        <div>
          <p style={{ color: '#57606a' }}>
            {preview.sheetName} · 共 {preview.total} 行,显示前 {preview.rows.length} 行
          </p>
          <table border={1} cellPadding={4} cellSpacing={0}>
            <thead>
              <tr>
                {preview.headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i}>
                  {preview.headers.map((h, j) => (
                    <td key={h}>{String(r[j] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: '#8b949e' }}>在左侧栏选择源文件后点击「加载预览」,查看真实数据。</p>
      )}
    </div>
  );
}
