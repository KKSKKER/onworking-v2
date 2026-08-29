// 视图:文件字段映射(参考 V1 RuleEditor:Sheet 选择 + 表头/截止行 + 自动检测 + 字段映射表)。
// 保存规则 → pipeline.save;保存模板 → template.save(真实后端)。
import { useEffect, useState } from 'react';
import { useSelection } from '../state/SelectionContext';
import type { MappingTemplate } from '../../core/template/store';
import type { FieldMapping } from '../../core/etl/transform';
import { canonicalizeHeaders } from '../../core/etl/headers';
import { sendCli } from '../cli';
import { patternToRegex } from '../../core/glob';

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

/** 规则 transform kind → 前端 ValueTransform。 */
function kindToTransform(kind: string): ValueTransform {
  switch (kind) {
    case 'coerce_cents': return 'to-cents';
    case 'coerce_date': return 'normalize-date';
    case 'coerce_string': return 'trim';
    default: return 'none';
  }
}

interface FieldRow {
  included: boolean;
  sourceHeader: string;
  outputName: string;
  transform: ValueTransform;
}

interface RuleInfo {
  name: string;
  sources: { pattern: string; sheetName?: string; headerRow: number }[];
  fields: { sourceHeader: string; outputName: string; order: number; transforms?: { kind: string }[] }[];
}

interface BigTableCtx {
  config: { fields: { name: string }[] };
  rules: RuleInfo[];
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
  // 大表配置里定义的字段名(映射到的目标列,下拉选项)
  const [bigTableFields, setBigTableFields] = useState<string[]>([]);
  // 已加载的规则(判断当前文件/sheet 是否已有映射 → 下拉标绿)
  const [rules, setRules] = useState<RuleInfo[]>([]);

  /** 把一条规则回填到视图(表头/字段/映射列)。 */
  function applyRuleToState(rule: RuleInfo) {
    const src = rule.sources[0];
    if (src?.headerRow) setHeaderRow(src.headerRow);
    if (src?.sheetName) setSheet(src.sheetName);
    setFields(
      rule.fields.map((f) => ({
        included: true,
        sourceHeader: f.sourceHeader,
        outputName: f.outputName,
        transform: kindToTransform(f.transforms?.[0]?.kind ?? 'none'),
      })),
    );
    // 必须置 detected 非空,字段表才渲染(否则一直走「请先获取表头」空态)
    setDetected({
      sheetName: src?.sheetName ?? '',
      headerRow: src?.headerRow ?? 1,
      headers: rule.fields.map((f) => f.sourceHeader),
    });
    setMsg(`已载入规则: ${rule.name}`);
  }

  /** 读取大表配置:目标列下拉选项(字段)+ 返回规则。 */
  async function loadBigTableCtx(folder: string): Promise<BigTableCtx | null> {
    const res = await sendCli({ cmd: 'bigtable.config', folder });
    if (!res.ok) return null;
    const ctx = res.data as BigTableCtx;
    setBigTableFields((ctx.config?.fields ?? []).map((f) => f.name));
    setRules(ctx.rules ?? []);
    return ctx;
  }

  /** 加载匹配指定文件的规则(按 pattern 匹配),命中则回填。 */
  async function loadRuleForFile(filePath: string): Promise<boolean> {
    if (!selectedFolder) return false;
    const ctx = await loadBigTableCtx(selectedFolder);
    if (!ctx) return false;
    const base = filePath.split(/[\\/]/).pop() ?? filePath;
    const rule = ctx.rules.find((r) => r.sources.some((s) => {
      const re = patternToRegex(s.pattern);
      return re.test(base) || re.test(filePath);
    }));
    if (!rule) return false;
    applyRuleToState(rule);
    return true;
  }

  // 跟随左侧栏选中的文件:清空旧状态 → 先载入 sheet 列表(保证下拉框在),再加载匹配规则回填
  useEffect(() => {
    if (!selectedFile) return;
    setFilePath(selectedFile);
    setMsg('');
    setDetected(null);
    setFields([]);
    setSheets([]);
    setSheet('');
    setHeaderRow(1);
    setEndRow('');
    void (async () => {
      await loadSheets(selectedFile); // 一定先载入 sheet,否则下拉框不显示
      await loadRuleForFile(selectedFile); // 有匹配规则则回填(选中 sheet + 字段);无则留空待检测
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile]);

  // 选中大表 → 读取已有规则 YAML 并回填字段表(打开视图即有已配置内容)
  useEffect(() => {
    if (selectedFolder) {
      void (async () => {
        const ctx = await loadBigTableCtx(selectedFolder);
        const rule = ctx?.rules?.[0];
        if (!rule) return;
        applyRuleToState(rule);
        const src = rule.sources[0];
        if (src?.sheetName && sheets.length === 0 && filePath) void loadSheets(filePath);
      })();
    } else {
      setFields([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder]);

  /** 加载 sheet 列表并返回默认选中的 sheet(供检测用)。 */
  async function loadSheets(path: string): Promise<string> {
    const res = await sendCli({ cmd: 'setup.sheets', filePath: path });
    if (res.ok) {
      const names = res.data as string[];
      setSheets(names);
      const pick = names[0] ?? '';
      setSheet(pick);
      return pick;
    }
    return '';
  }

  async function handleDetect(sheetName?: string) {
    if (!filePath.trim()) return;
    setMsg('');
    const target = sheetName ?? sheet;
    if (sheets.length === 0) await loadSheets(filePath);
    const res = await sendCli({ cmd: 'setup.detectSource', filePath, sheetName: target || undefined });
    if (!res.ok) {
      setMsg(`检测失败: ${res.error.message}`);
      return;
    }
    const d = res.data as DetectResult;
    setDetected(d);
    setHeaderRow(d.headerRow);
    setSheet(target);
    setFields(
      canonicalizeHeaders(d.headers).names.map((h) => ({
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
    if (!selectedFolder) {
      setMsg('请先选择目标大表');
      return;
    }
    // 只保存字段映射(YAML 规则),不生成管线
    const res = await sendCli({
      cmd: 'mapping.save',
      folder: selectedFolder,
      headerRow,
      mappings: buildMappings(),
    });
    setMsg(res.ok ? '映射已保存(规则)' : `保存失败: ${res.error.message}`);
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
    const res = await sendCli({ cmd: 'template.save', template: tpl });
    setMsg(res.ok ? `模板已保存: ${tpl.name}` : `保存失败: ${res.error.message}`);
  }

  /** 删除当前 (文件, sheet) 的映射规则。 */
  async function handleDeleteRule() {
    if (!selectedFolder || !currentRule) return;
    if (!window.confirm(`确定删除 sheet「${sheet}」的映射规则「${currentRule.name}」?`)) return;
    const res = await sendCli({ cmd: 'mapping.delete', folder: selectedFolder, ruleName: currentRule.name });
    if (!res.ok) {
      setMsg(`删除失败: ${res.error.message}`);
      return;
    }
    setMsg(`已删除规则「${currentRule.name}」`);
    // 刷新:重载规则状态;若还有其它规则命中该文件则回填,否则清空待检测
    setDetected(null);
    setFields([]);
    await loadBigTableCtx(selectedFolder);
    if (selectedFile) {
      const loaded = await loadRuleForFile(selectedFile);
      if (!loaded) await loadSheets(selectedFile);
    }
  }

  const target = selectedFolder ?? '(未选择大表)';
  // 当前 (文件, sheet) 命中的规则(pattern + sheetName),用于标绿与删除
  const currentRule = selectedFile ? rules.find((r) =>
    r.sources.some((s) => {
      const re = patternToRegex(s.pattern);
      const base = selectedFile.split(/[\\/]/).pop() ?? selectedFile;
      return (re.test(base) || re.test(selectedFile)) && (!s.sheetName || s.sheetName === sheet);
    }),
  ) : undefined;
  const currentSheetMapped = !!currentRule;

  return (
    <div style={{ padding: 12, height: '100%', boxSizing: 'border-box', overflow: 'auto' }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        源文件{' '}
        <input style={{ width: 260 }} value={filePath} onChange={(e) => setFilePath(e.target.value)} />{' '}
        <button onClick={() => void handleDetect()}>一键获取表头</button>
      </div>
      {sheets.length > 0 && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>
            Sheet({sheets.length}):{' '}
            <select
              value={sheet}
              onChange={(e) => {
                const v = e.target.value;
                setSheet(v);
                void handleDetect(v); // 切换 sheet → 重新检测该 sheet 的表头,字段表即时更新
              }}
              style={{
                width: 180,
                ...(currentSheetMapped ? { border: '1px solid #1a7f37', color: '#1a7f37', fontWeight: 600 } : {}),
              }}
              title={currentSheetMapped ? '该 sheet 已有映射规则' : '该 sheet 无映射规则'}
            >
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {currentSheetMapped && s === sheet ? '✓ ' : ''}{s}
                </option>
              ))}
            </select>
          </span>
          {currentSheetMapped && (
            <button
              onClick={() => void handleDeleteRule()}
              title={`删除 sheet「${sheet}」的映射规则`}
              style={{ color: '#d00', border: '1px solid #d00', background: 'none', borderRadius: 3, padding: '2px 8px', fontSize: 12, cursor: 'pointer' }}
            >
              删除该映射
            </button>
          )}
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
                    <select value={f.outputName} onChange={(e) => setField(i, 'outputName', e.target.value)}>
                      {/* 下拉选项 = 大表配置字段;当前值不在其中时也保留,避免已有映射丢失 */}
                      {[...new Set([...bigTableFields, f.outputName])].filter(Boolean).map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
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
