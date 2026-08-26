// 视图:大表配置 —— 对齐 V1 的紧凑表格长相:表名/自增主键 + 字段表(主键勾选/字段名/类型/▲▼排序/✕)+ 底部新增行 + 绿色保存。
// 规则 YAML / 关联管线只读展示(V2 扩展)。编辑态只在大表切换时初始化,reload 不重置(输入不被自动刷新打断)。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BigTableConfig } from '../../core/bigtable/schema';
import { useApi } from './useApi';
import { useSelection } from '../state/SelectionContext';
import { sendCli } from '../cli';

const FIELD_TYPES = ['TEXT', 'INTEGER', 'REAL'] as const;

interface BigTableContext {
  folder: string;
  sourceDir: string;
  config: BigTableConfig;
  rules: {
    name: string;
    sources: { pattern: string; sheetName?: string; headerRow: number }[];
    fields: { sourceHeader: string; outputName: string; order: number }[];
  }[];
  pipelines: { id: string; kind: string; label: string }[];
}

const inputStyle: CSSProperties = {
  padding: '3px 6px', fontSize: 12, border: '1px solid #ccc', borderRadius: 3,
};

export function BigTableSettingsView() {
  const { selectedFolder } = useSelection();
  const { data: folders } = useApi<string[]>({ cmd: 'bigtable.list' });
  const folder = selectedFolder ?? folders?.[0] ?? null;

  const { data: ctx, reload } = useApi<BigTableContext>(
    folder ? { cmd: 'bigtable.config', folder } : { cmd: 'bigtable.list' },
    !!folder,
  );
  const [cfg, setCfg] = useState<BigTableConfig | null>(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<(typeof FIELD_TYPES)[number]>('TEXT');
  // 新增清洗管线弹窗(sourceDir 锁定为大表自己的 source 目录,不用手填)
  const [creatingClean, setCreatingClean] = useState(false);
  const [cleanId, setCleanId] = useState('c1');
  const [cleanMsg, setCleanMsg] = useState('');
  // 记录当前本地编辑态对应的大表;只在首次加载/切换大表时初始化,
  // reload / workspace:changed 不再重置(否则输入会被自动刷新打断)。
  const cfgFolderRef = useRef<string | null>(null);

  // folder 变化 → 清空编辑态,避免短暂显示上一个大表的配置
  useEffect(() => {
    setCfg(null);
    setSaveMsg('');
  }, [folder]);

  // 仅当 ctx 确实属于当前大表时才初始化本地编辑态;
  // 同一大表 reload 不重置(输入不被自动刷新打断),切表时不会被 stale 的旧 ctx 带偏。
  useEffect(() => {
    if (!ctx || ctx.folder !== folder) return;
    if (cfgFolderRef.current !== folder) {
      cfgFolderRef.current = folder;
      setCfg(JSON.parse(JSON.stringify(ctx.config)) as BigTableConfig);
    }
    setSaveMsg('');
  }, [ctx, folder]);

  async function handleRefresh() {
    cfgFolderRef.current = null; // 强制下次 ctx 到达时重新读取服务端值
    setCfg(null);
    reload();
  }

  async function handleSave() {
    if (!cfg || !folder) return;
    const res = await sendCli({ cmd: 'bigtable.save', folder, config: cfg });
    setSaveMsg(res.ok ? '已保存 ✓' : `保存失败: ${res.error.message}`);
  }

  function openCleanCreate() {
    setCleanId('c1');
    setCleanMsg('');
    setCreatingClean(true);
  }

  async function confirmClean() {
    if (!folder) return;
    const id = cleanId.trim();
    const sourceDir = ctx?.sourceDir ?? '';
    if (!id || !sourceDir) {
      setCleanMsg('管线 id 必填(源目录已锁定为大表 source 目录)');
      return;
    }
    setCleanMsg('');
    const res = await sendCli({
      cmd: 'pipeline.save',
      config: { kind: 'clean', id, label: `${folder}清洗`, bigTableFolder: folder, sourceDir, createdAt: new Date().toISOString() },
    });
    if (!res.ok) {
      setCleanMsg(`创建失败: ${res.error.message}`);
      return;
    }
    setCreatingClean(false);
    setSaveMsg(`已创建清洗管线「${id}」(可在管线管理里运行)`);
  }

  function addField() {
    if (!cfg) return;
    const name = newFieldName.trim();
    if (!name) return;
    setCfg({
      ...cfg,
      fields: [...cfg.fields, { name, type: newFieldType, order: cfg.fields.length + 1 }],
    });
    setNewFieldName('');
  }

  function removeField(index: number) {
    if (!cfg) return;
    setCfg({ ...cfg, fields: cfg.fields.filter((_, i) => i !== index) });
  }

  function moveField(index: number, dir: -1 | 1) {
    if (!cfg) return;
    const to = index + dir;
    if (to < 0 || to >= cfg.fields.length) return;
    const fields = cfg.fields.map((f, i) => ({ ...f, order: i + 1 })); // 先按当前位置重排
    const [moved] = fields.splice(index, 1);
    fields.splice(to, 0, moved);
    setCfg({ ...cfg, fields: fields.map((f, i) => ({ ...f, order: i + 1 })) });
  }

  function setField(index: number, key: 'name' | 'type' | 'primaryKey', value: unknown) {
    if (!cfg) return;
    const fields = cfg.fields.map((f, i) => (i === index ? { ...f, [key]: value } : f));
    setCfg({ ...cfg, fields });
  }

  if (!folder) {
    return <div style={{ padding: 16, fontSize: 12, color: '#666' }}>在左侧栏选择一个大表开始。</div>;
  }

  return (
    <div style={{ fontSize: 12, padding: 16, height: '100%', boxSizing: 'border-box', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>大表配置「{folder}」</h3>
        <button onClick={() => void handleRefresh()} style={{ padding: '3px 10px', fontSize: 12 }}>刷新</button>
      </div>

      {cfg ? (
        <>
          <div style={{ marginBottom: 12, display: 'flex', gap: 16, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>表名</span>
              <input value={cfg.tableName} onChange={(e) => setCfg({ ...cfg, tableName: e.target.value })} style={{ ...inputStyle, width: 180 }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.autoIncrement} onChange={(e) => setCfg({ ...cfg, autoIncrement: e.target.checked })} />
              <span>自增主键</span>
            </label>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead>
              <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px', width: 48 }}>主键</th>
                <th style={{ padding: '6px 8px' }}>字段名</th>
                <th style={{ padding: '6px 8px' }}>类型</th>
                <th style={{ padding: '6px 8px', width: 88 }}>排序</th>
                <th style={{ padding: '6px 8px', width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {cfg.fields.map((f, i) => (
                <tr key={f.name + i} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '4px 8px' }}>
                    <input
                      type="checkbox"
                      checked={!!f.primaryKey}
                      disabled={cfg.autoIncrement}
                      onChange={(e) => setField(i, 'primaryKey', e.target.checked)}
                    />
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <input value={f.name} onChange={(e) => setField(i, 'name', e.target.value)} style={inputStyle} />
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <select value={f.type} onChange={(e) => setField(i, 'type', e.target.value)} style={{ ...inputStyle, fontSize: 11 }}>
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <button onClick={() => moveField(i, -1)} disabled={i <= 0} style={{ border: 'none', cursor: 'pointer' }}>▲</button>
                    <button onClick={() => moveField(i, 1)} disabled={i >= cfg.fields.length - 1} style={{ border: 'none', cursor: 'pointer' }}>▼</button>
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <button onClick={() => removeField(i)} style={{ border: 'none', cursor: 'pointer', color: '#d00' }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <input
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addField(); }}
              placeholder="新字段名"
              style={{ ...inputStyle, width: 120 }}
            />
            <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value as (typeof FIELD_TYPES)[number])} style={{ ...inputStyle, fontSize: 11 }}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button onClick={addField} style={{ padding: '4px 12px', background: '#007acc', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer' }}>
              + 添加字段
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => void handleSave()} style={{ padding: '6px 16px', background: '#28a745', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 13 }}>
              💾 保存设置
            </button>
            <button onClick={openCleanCreate} style={{ padding: '6px 12px', background: '#007acc', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 13 }}>
              ＋ 新增清洗管线
            </button>
            {saveMsg && <span style={{ fontSize: 12 }}>{saveMsg}</span>}
          </div>

          <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid #eee' }} />
          <div style={{ marginBottom: 8 }}>
            <b>规则 YAML({ctx?.rules.length ?? 0}):</b>
            {(ctx?.rules ?? []).map((r, i) => (
              <pre key={i} style={{ background: '#f6f8fa', padding: 8, overflow: 'auto', fontSize: 11 }}>
                {JSON.stringify(r, null, 2)}
              </pre>
            ))}
          </div>
          <div>
            <b>关联管线({ctx?.pipelines.length ?? 0}):</b>
            {(ctx?.pipelines ?? []).map((p) => (
              <div key={p.id} style={{ padding: '2px 0' }}>
                {p.id} ({p.kind}) {p.label}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p style={{ color: '#999' }}>加载中…</p>
      )}

      {creatingClean && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setCreatingClean(false)}
        >
          <div
            style={{ background: '#fff', border: '1px solid #d0d7de', borderRadius: 8, padding: 16, width: 420, boxShadow: '0 8px 24px rgba(0,0,0,.15)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <b>新增清洗管线(源文件 → 大表)</b>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <label>
                管线 id{' '}
                <input value={cleanId} onChange={(e) => setCleanId(e.target.value)} placeholder="如 c1" style={{ ...inputStyle, width: 180 }} />
              </label>
              <div>
                源目录(sourceDir): <code style={{ background: '#f6f8fa', padding: '2px 4px', borderRadius: 3 }}>{ctx?.sourceDir ?? '…'}</code>
              </div>
              <div style={{ color: '#8b949e', fontSize: 12 }}>
                源目录已锁定为大表自己的 source 目录(「📥 导入」的文件所在处),不用手填。
              </div>
              <div>
                大表: <b>{folder}</b>(固定为本大表)
              </div>
              <div style={{ color: '#8b949e', fontSize: 12 }}>
                仅创建管线;运行请到「管线管理」视图。清洗需要先有字段映射(文件字段映射视图)。
              </div>
              {cleanMsg && <div style={{ color: 'red', fontSize: 12 }}>{cleanMsg}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setCreatingClean(false)}>取消</button>
                <button onClick={() => void confirmClean()} style={{ background: '#007acc', color: 'white', border: 'none', borderRadius: 3, padding: '4px 12px', cursor: 'pointer' }}>
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
