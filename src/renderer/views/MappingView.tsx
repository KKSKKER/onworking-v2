// 视图:文件字段映射(参考 V1 RuleEditor:Sheet 选择 + 表头/截止行 + 自动检测 + 字段映射表)。
// 保存规则 → pipeline.save;保存模板 → template.save(真实后端)。
import { useEffect, useState } from 'react';
import { useSelection } from '../state/SelectionContext';
import type { CleanPipelineConfig } from '../../core/pipeline/config';
import type { MappingTemplate } from '../../core/template/store';
import type { FieldMapping } from '../../core/etl/transform';

interface DetectResult {
  sheetName: string;
  headerRow: number;
  headers: string[];
}

type ValueTransform = 'none' | 'to-cents' | 'normalize-date' | 'trim';
const TRANSFORM_OPTIONS: { value: ValueTransform; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'to-cents', label: '元转分' },
  { value: 'normalize-date', label: '日期归一化' },
  { value: 'trim', label: '去空格' },
];

interface FieldRow {
  included: boolean;
  sourceHeader: string;
  outputName: string;
  transform: ValueTransform;
}

export function MappingView() {
  const { selectedFile, selectedFolder } = useSelection();
  const [filePath, setFilePath] = useState(selectedFile ?? '');
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string>('');
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [endRow, setEndRow] = useState('');
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [msg, setMsg] = useState('');

  // 跟随左侧栏选中的文件
  useEffect(() => {
    if (selectedFile) {
      setFilePath(selectedFile);
      setDetected(null);
      setFields([]);
      loadSheets(selectedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile]);

  async function loadSheets(path: string) {
    const res = await window.onw.invoke({ cmd: 'setup.sheets', filePath: path });
    if (res.ok) {
      const names = res.data as string[];
      setSheets(names);
      if (names.length > 0) setSheet(names[0]);
    }
  }

  async function handleDetect() {
    if (!filePath.trim()) return;
    setMsg('');
    if (sheets.length === 0) await loadSheets(filePath);
    const res = await window.onw.invoke({ cmd: 'setup.detectSource', filePath, sheetName: sheet || undefined });
    if (!res.ok) {
      setMsg(`检测失败: ${res.error.message}`);
      return;
    }
    const d = res.data as DetectResult;
    setDetected(d);
    setHeaderRow(d.headerRow);
    setFields(
      d.headers.map((h) => ({
        included: true,
        sourceHeader: h,
        outputName: h,
        transform: /金额|借方|贷方|余额|amount|amt/i.test(h) ? ('to-cents' as const) : ('none' as const),
      })),
    );
  }

  function buildMappings(): FieldMapping[] {
    return fields
      .filter((f) => f.included)
      .map((f) => ({ sourceHeader: f.sourceHeader, outputName: f.outputName, transform: f.transform }));
  }

  async function handleSave() {
    if (!selectedFolder || !filePath.trim()) {
      setMsg('请先选择目标大表并输入源文件路径');
      return;
    }
    const sourceDir = filePath.split(/[\\/]/).slice(0, -1).join('/') || '.';
    const config: CleanPipelineConfig = {
      kind: 'clean',
      id: `c_${Date.now()}`,
      label: `${selectedFolder}清洗`,
      bigTableFolder: selectedFolder,
      sourceDir,
      sheetName: sheet || undefined,
      headerRow,
      mappings: buildMappings(),
      createdAt: new Date().toISOString(),
    };
    const res = await window.onw.invoke({ cmd: 'pipeline.save', config });
    setMsg(res.ok ? `规则已保存: ${config.id}` : `保存失败: ${res.error.message}`);
  }

  async function handleSaveTemplate() {
    if (fields.length === 0) {
      setMsg('请先获取表头再保存模板');
      return;
    }
    const tpl: MappingTemplate = {
      name: sheet || '新模板',
      mappings: buildMappings(),
      createdAt: new Date().toISOString(),
    };
    const res = await window.onw.invoke({ cmd: 'template.save', template: tpl });
    setMsg(res.ok ? `模板已保存: ${tpl.name}` : `保存失败: ${res.error.message}`);
  }

  const target = selectedFolder ?? '(未选择大表)';

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        源文件{' '}
        <input style={{ width: 260 }} value={filePath} onChange={(e) => setFilePath(e.target.value)} />{' '}
        <button onClick={handleDetect}>一键获取表头</button>
      </div>
      {sheets.length > 0 && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>
            Sheet({sheets.length}):{' '}
            <select value={sheet} onChange={(e) => setSheet(e.target.value)} style={{ width: 180 }}>
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </span>
          <span>
            表头行{' '}
            <input type="number" value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))} style={{ width: 50 }} />
          </span>
          <span>
            截止行 <input value={endRow} onChange={(e) => setEndRow(e.target.value)} style={{ width: 60 }} placeholder="末尾" />
          </span>
          <span>
            映射到大表: <b>{target}</b>
          </span>
        </div>
      )}
      {detected && fields.length > 0 && (
        <div>
          <table border={1} cellPadding={4} cellSpacing={0}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={fields.every((f) => f.included)}
                    onChange={(e) => setFields(fields.map((f) => ({ ...f, included: e.target.checked })))}
                  />
                </th>
                <th>源字段</th>
                <th>映射到</th>
                <th>清洗转换</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={i} style={{ opacity: f.included ? 1 : 0.4 }}>
                  <td>
                    <input type="checkbox" checked={f.included} onChange={(e) => setField(i, 'included', e.target.checked)} />
                  </td>
                  <td>{f.sourceHeader}</td>
                  <td>
                    <input value={f.outputName} onChange={(e) => setField(i, 'outputName', e.target.value)} />
                  </td>
                  <td>
                    <select
                      value={f.transform}
                      onChange={(e) => setField(i, 'transform', e.target.value)}
                    >
                      {TRANSFORM_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <button onClick={handleSave}>💾 保存规则</button>{' '}
            <button onClick={handleSaveTemplate}>保存为模板</button>{' '}
            <span>{msg}</span>
          </div>
        </div>
      )}
      {!detected && (
        <p style={{ color: '#8b949e' }}>
          在左侧栏选择源文件,或输入路径后点「一键获取表头」。
        </p>
      )}
    </div>
  );

  function setField(index: number, key: 'included' | 'outputName' | 'transform', value: unknown) {
    setFields(fields.map((f, i) => (i === index ? { ...f, [key]: value } : f)));
  }
}
