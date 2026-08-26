// 临时诊断:逐文件逐 sheet 报告 !ref 范围(不物化),并标记密码保护文件。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

const dir = process.argv[2] ?? '.';
const files = readdirSync(dir).filter((f) => /\.(xlsx|xls)$/i.test(f));
for (const f of files) {
  const path = join(dir, f);
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(path);
  } catch (e) {
    console.log(`!! PASSWORD-PROTECTED / UNREADABLE: ${f} :: ${String(e).slice(0, 80)}`);
    continue;
  }
  const lines: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'];
    if (!ref) { lines.push(`  ${name}: (empty)`); continue; }
    const r = XLSX.utils.decode_range(ref);
    const cells = (r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1);
    const mark = cells > 5_000_000 ? ' ⚠HUGE' : '';
    lines.push(`  ${name}: rows=${r.e.r - r.s.r + 1} cols=${r.e.c - r.s.c + 1} cells=${cells}${mark}`);
  }
  console.log(`== ${f} (${wb.SheetNames.length} sheets)`);
  console.log(lines.join('\n'));
}
