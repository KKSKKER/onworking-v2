// src/core/ingest/scanner.ts
// 递归扫描源目录,返回支持的文件(xlsx/xls/csv)。
import { readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const SUPPORTED_EXT = new Set(['.xlsx', '.xls', '.csv']);

export interface ScannedFile {
  path: string;
  relPath: string;
}

export function scanSourceDir(sourceDir: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SUPPORTED_EXT.has(extname(entry.name).toLowerCase())) {
        out.push({ path: full, relPath: relative(sourceDir, full) });
      }
    }
  };
  walk(sourceDir);
  return out;
}
