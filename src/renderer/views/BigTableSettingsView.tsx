// 视图:大表字段设置。列出大表,选中后编辑字段(名/类型/主键/排序)。
import { useEffect, useState } from 'react';
import type { BigTableConfig } from '../../core/bigtable/schema';
import { useApi } from './useApi';

const FIELD_TYPES = ['text', 'cents', 'number', 'date'] as const;

export function BigTableSettingsView() {
  const { data: folders } = useApi<string[]>({ cmd: 'bigtable.list' });
  const [selected, setSelected] = useState('序时账');
  const { data: fetchedCfg, reload } = useApi<BigTableConfig>({ cmd: 'bigtable.get', folder: selected });
  const [cfg, setCfg] = useState<BigTableConfig | null>(null);
  const [saveMsg, setSaveMsg] = useState('');

  // 数据到达或切换大表时,同步到本地可编辑副本
  useEffect(() => {
    if (fetchedCfg) setCfg(JSON.parse(JSON.stringify(fetchedCfg)) as BigTableConfig);
  }, [fetchedCfg]);

  async function handleSave() {
    if (!cfg) return;
    const res = await window.onw.invoke({ cmd: 'bigtable.save', folder: selected, config: cfg });
    setSaveMsg(res.ok ? '已保存 ✓' : `保存失败: ${res.error.message}`);
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        大表:
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {(folders ?? []).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button onClick={reload}>刷新</button>
      </div>
      {cfg ? (
        <div>
          <div style={{ marginBottom: 8 }}>
            表名{' '}
            <input value={cfg.tableName} onChange={(e) => setCfg({ ...cfg, tableName: e.target.value })} />{' '}
            自增主键{' '}
            <input
              type="checkbox"
              checked={cfg.autoIncrement}
              onChange={(e) => setCfg({ ...cfg, autoIncrement: e.target.checked })}
            />
          </div>
          <table border={1} cellPadding={4} cellSpacing={0}>
            <thead>
              <tr>
                <th>字段名</th>
                <th>类型</th>
                <th>主键</th>
                <th>排序</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cfg.fields.map((f, i) => (
                <tr key={f.name + i}>
                  <td>
                    <input
                      value={f.name}
                      onChange={(e) =>
                        setField(i, 'name', e.target.value)
                      }
                    />
                  </td>
                  <td>
                    <select
                      value={f.type}
                      onChange={(e) => setField(i, 'type', e.target.value)}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!f.primaryKey}
                      onChange={(e) => setField(i, 'primaryKey', e.target.checked)}
                    />
                  </td>
                  <td>{f.order}</td>
                  <td>
                    <button onClick={() => removeField(i)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <button onClick={addField}>+ 新增字段</button>{' '}
            <button onClick={handleSave}>💾 保存设置</button>{' '}
            <span>{saveMsg}</span>
          </div>
        </div>
      ) : (
        <p>加载中…</p>
      )}
    </div>
  );

  function setField(index: number, key: 'name' | 'type' | 'primaryKey', value: unknown) {
    if (!cfg) return;
    const fields = cfg.fields.map((f, i) => (i === index ? { ...f, [key]: value } : f));
    setCfg({ ...cfg, fields });
  }
  function addField() {
    if (!cfg) return;
    const order = cfg.fields.length + 1;
    setCfg({ ...cfg, fields: [...cfg.fields, { name: `field${order}`, type: 'text', order }] });
  }
  function removeField(index: number) {
    if (!cfg) return;
    setCfg({ ...cfg, fields: cfg.fields.filter((_, i) => i !== index) });
  }
}
