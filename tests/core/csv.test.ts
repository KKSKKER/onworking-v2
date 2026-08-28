import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvEscape, writeRowsToCsvFile } from '../../src/core/export/csv';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ow-csv-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeRowsToCsvFile', () => {
  it('表头 + 行,无 BOM、LF、无尾换行,与旧实现字节一致', async () => {
    const file = join(dir, 'out.csv');
    const rows = [
      { date: '2024-01', debit: 100, note: 'a,b' },
      { date: '2024-02', debit: -5, note: 'x"y' },
    ];
    const n = await writeRowsToCsvFile(file, ['date', 'debit', 'note'], rows);
    expect(n).toBe(2);
    const bytes = readFileSync(file);
    expect(bytes[0]).not.toBe(0xef); // 无 BOM
    expect(bytes.toString('utf-8')).toBe('date,debit,note\n2024-01,100,"a,b"\n2024-02,-5,"x""y"');
  });

  it('空结果集:仅表头行', async () => {
    const file = join(dir, 'empty.csv');
    const n = await writeRowsToCsvFile(file, ['a', 'b'], []);
    expect(n).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe('a,b');
  });

  it('接受异步可迭代(游标产物)', async () => {
    const file = join(dir, 'async.csv');
    async function* gen(): AsyncGenerator<Record<string, unknown>> {
      yield { a: 1 };
      yield { a: 2 };
    }
    const n = await writeRowsToCsvFile(file, ['a'], gen());
    expect(n).toBe(2);
    expect(readFileSync(file, 'utf-8')).toBe('a\n1\n2');
  });

  it('csvEscape 转义逗号/引号/换行,空值转空串', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(100)).toBe('100');
  });
});
