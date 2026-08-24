// 视图:预览。核对源文件表头行 / 截止行与数据。
import { useState } from 'react';

interface PreviewSheet {
  headers: string[];
  rows: (string | number)[][];
}

// 演示数据(浏览器 mock 无真实预览,先给样例)
const SAMPLE: PreviewSheet = {
  headers: ['日期', '借方金额', '摘要'],
  rows: [
    ['2024-01-15', 123456, '计提工资'],
    ['2024-01-16', 8200, '差旅报销'],
    ['2024-02-01', 50000, '采购'],
  ],
};

export function PreviewView() {
  const [headerRow, setHeaderRow] = useState(1);
  const [endRow, setEndRow] = useState('');
  const [loaded, setLoaded] = useState(false);

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        文件: D:/演示工作区/序时账/source/序时账.xlsx · 表头行{' '}
        <input
          type="number"
          value={headerRow}
          onChange={(e) => setHeaderRow(Number(e.target.value))}
          style={{ width: 50 }}
        />{' '}
        截止行 <input value={endRow} onChange={(e) => setEndRow(e.target.value)} style={{ width: 60 }} />{' '}
        <button onClick={() => setLoaded(true)}>加载预览</button>
      </div>
      {loaded ? (
        <div>
          <p>已加载:共 {SAMPLE.rows.length} 行 {SAMPLE.headers.length} 列</p>
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
        <p>点击「加载预览」查看源文件。</p>
      )}
    </div>
  );
}
