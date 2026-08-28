// src/core/export/csv.ts
// 流式 CSV 落盘:better-sqlite3 游标/生成器逐行写盘,不物化、无 BOM、LF 换行、无尾换行。
// csvEscape 与旧 toolExport* 逐字节一致(RFC 4180 子集):只有 String(v),没有 Date/JSON 分支。
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 流式写 CSV:游标/生成器逐行写盘,不物化。drain 背压保证 O(1) 内存。
 * 无 BOM、LF 换行、无尾换行,与旧实现字节一致。
 * @returns 写入的数据行数(不含表头行)
 */
export async function writeRowsToCsvFile(
  file: string,
  columns: string[],
  rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>
): Promise<number> {
  mkdirSync(dirname(file), { recursive: true });
  const ws = createWriteStream(file, { encoding: 'utf8', flags: 'w' });
  let count = 0;
  try {
    ws.write(columns.join(','));
    for await (const r of rows) {
      const line = `\n${columns.map((c) => csvEscape(r[c])).join(',')}`;
      if (!ws.write(line)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => { ws.off('error', onError); resolve(); };
          const onError = (err: Error): void => { ws.off('drain', onDrain); reject(err); };
          ws.once('drain', onDrain);
          ws.once('error', onError);
        });
      }
      count++;
    }
    await new Promise<void>((resolve, reject) => {
      ws.end();
      ws.once('finish', resolve);
      ws.once('error', reject);
    });
    return count;
  } catch (err) {
    ws.destroy();
    throw err;
  }
}
