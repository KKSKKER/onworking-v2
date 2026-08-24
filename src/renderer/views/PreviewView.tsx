// 视图:预览。核对源文件表头行/截止行与数据(跟随左侧栏选中的文件)。
import { useState } from 'react';
import { useSelection } from '../state/SelectionContext';

interface PreviewSheet {
  headers: string[];
  rows: (string | number)[][];
}

const SAMPLE: PreviewSheet = {
  headers: ['日期', '借方金额', '摘要'],
  rows: [
    ['2024-01-15', 123456, '计提工资'],
    ['2024-01-16', 8200, '差旅报销'],
    ['2024-02-01', 50000, '采购'],
  ],
};

export function PreviewView() {
  const { selectedFile } = useSelection();
  const [headerRow, setHeaderRow] = useState(1);
  const [endRow, setEndRow] = useState('');
  const [loaded, setLoaded] = useState(false);

  const fileName = selectedFile ? selectedFile.split(/[\\/]/).pop() : '(在左侧栏选择源文件)';

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        文件: {fileName} · 表头行{' '}
        <input
          type="number"
          value={headerRow}
          onChange={(e) => setHeaderRow(Number(e.target.value))}
          style={{ width: 50 }}
        />{' '}
        截止行 <input value={endRow} onChange={(e) => setEndRow(e.target.value)} style={{ width: 60 }} />{' '}
        <button onClick={() => setLoaded(true)}>加载预览</button>
      </div>
      {loaded && selectedFile ? (
        <div>
          <p>
            已加载:共 {SAMPLE.rows.length} 行 {SAMPLE.headers.length} 列
          </p>
          <table border={1} cellPadding={4} cellSpacing={0}>
            <thead>
              <tr>
                {SAMPLE.headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SAMPLE.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{String(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>在左侧栏选择源文件后点击「加载预览」。</p>
      )}
    </div>
  );
}
