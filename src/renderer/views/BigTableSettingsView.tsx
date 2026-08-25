// 视图:大表字段设置。跟随左侧栏选中的大表,编辑字段(名/类型/主键/排序)。
import { useEffect, useState } from 'react';
import type { BigTableConfig } from '../../core/bigtable/schema';
import { useApi } from './useApi';
import { useSelection } from '../state/SelectionContext';
import { sendCli } from '../cli';

const FIELD_TYPES = ['TEXT', 'INTEGER', 'REAL'] as const;

export function BigTableSettingsView() {
  const { selectedFolder } = useSelection();
  const { data: folders } = useApi<string[]>({ cmd: 'bigtable.list' });
  const folder = selectedFolder ?? folders?.[0] ?? null;

  const { data: fetchedCfg, reload } = useApi<BigTableConfig>(
    folder ? { cmd: 'bigtable.get', folder } : { cmd: 'bigtable.list' },
    !!folder,
  );
  const [cfg, setCfg] = useState<BigTableConfig | null>(null);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    if (fetchedCfg) setCfg(JSON.parse(JSON.stringify(fetchedCfg)) as BigTableConfig);
    setSaveMsg('');
  }, [fetchedCfg]);

  async function handleSave() {
    if (!cfg || !folder) return;
    const res = await sendCli({ cmd: 'bigtable.save', folder, config: cfg });
    setSaveMsg(res.ok ? '已保存 ✓' : `保存失败: ${res.error.message}`);
  }

  if (!folder) {
    return <div style={{ padding: 12 }}>在左侧栏选择一个大表开始。</div>;
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        大表: <b>{folder}</b>
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
                    <input value={f.name} onChange={(e) => setField(i, 'name', e.target.value)} />
                  </td>
                  <td>
                    <select value={f.type} onChange={(e) => setField(i, 'type', e.target.value)}>
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
    setCfg({ ...cfg, fields: [...cfg.fields, { name: `field${order}`, type: 'TEXT', order }] });
  }
  function removeField(index: number) {
    if (!cfg) return;
    setCfg({ ...cfg, fields: cfg.fields.filter((_, i) => i !== index) });
  }
}
