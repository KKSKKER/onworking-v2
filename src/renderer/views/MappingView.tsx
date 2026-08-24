// 视图:文件字段映射。选择源文件 → 检测表头 → 把源列映射到大表字段。
import { useState } from 'react';
import { useApi } from './useApi';

interface DetectResult {
  sheetName: string;
  headerRow: number;
  headers: string[];
}

export function MappingView() {
  const [filePath, setFilePath] = useState('D:/演示工作区/序时账/source/序时账.xlsx');
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const { data: folders } = useApi<string[]>({ cmd: 'bigtable.list' });
  const [targetTable, setTargetTable] = useState('序时账');
  const [msg, setMsg] = useState('');

  async function handleDetect() {
    const res = await window.onw.invoke({ cmd: 'setup.detectSource', filePath });
    if (res.ok) setDetected(res.data as DetectResult);
    else setMsg(`检测失败: ${res.error.message}`);
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        源文件{' '}
        <input style={{ width: 320 }} value={filePath} onChange={(e) => setFilePath(e.target.value)} />{' '}
        <button onClick={handleDetect}>一键获取表头</button>
      </div>
      <div style={{ marginBottom: 8 }}>
        映射到大表{' '}
        <select value={targetTable} onChange={(e) => setTargetTable(e.target.value)}>
          {(folders ?? []).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      {detected ? (
        <div>
          <p>
            Sheet: {detected.sheetName} · 表头行: {detected.headerRow}
          </p>
          <table border={1} cellPadding={4} cellSpacing={0}>
            <thead>
              <tr>
                <th>☑</th>
                <th>源字段</th>
                <th>映射到</th>
                <th>类型</th>
              </tr>
            </thead>
            <tbody>
              {detected.headers.map((h, i) => (
                <tr key={i}>
                  <td>
                    <input type="checkbox" defaultChecked />
                  </td>
                  <td>{h}</td>
                  <td>
                    <input placeholder="输出字段名" defaultValue={h} />
                  </td>
                  <td>
                    <select defaultValue="text">
                      <option value="text">text</option>
                      <option value="cents">cents</option>
                      <option value="number">number</option>
                      <option value="date">date</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => setMsg('映射已保存(演示)')}>💾 保存规则</button>{' '}
          <button onClick={() => setMsg('已保存为模板(演示)')}>保存为模板</button>{' '}
          <span>{msg}</span>
        </div>
      ) : (
        <p>点击「一键获取表头」开始。</p>
      )}
    </div>
  );
}
