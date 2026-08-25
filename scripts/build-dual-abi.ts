// scripts/build-dual-abi.ts
// 双 ABI 构建:让 better-sqlite3 同时可用系统 node(137) 和 Electron(115)。
//  1) npm rebuild better-sqlite3 → 原件回系统 node ABI(137)
//  2) 复制原件 → node_modules/better-sqlite3-electron(副本)
//  3) node-gyp 直建副本 → Electron ABI(115)(只动副本)
// 结果:原件 better-sqlite3=node(137),副本 better-sqlite3-electron=electron(115);
//      运行时 src/core/db/sqlite.ts 按进程 ABI 自动选。
// 注意:步骤1 会删原件 .node —— 若被 app/MCP 占用会 EPERM,先关掉再跑。
// 用法: npm run build:dual-abi
import { execSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'node_modules', 'better-sqlite3');
const dst = join(root, 'node_modules', 'better-sqlite3-electron');
// Electron 主版本(devDeps electron ^31 → ABI 115)
const electronVer = '31.7.7';

console.log('[1/4] npm rebuild better-sqlite3 → 系统 node ABI(137)');
execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });

console.log('[2/4] 复制原件 → better-sqlite3-electron');
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });

console.log('[3/4] 改副本包名');
const pj = join(dst, 'package.json');
const cfg = JSON.parse(readFileSync(pj, 'utf8')) as { name: string };
cfg.name = 'better-sqlite3-electron';
writeFileSync(pj, JSON.stringify(cfg, null, 2), 'utf8');

console.log('[4/4] node-gyp 直建副本 → Electron ABI(115)');
execSync(
  `npx node-gyp rebuild --runtime=electron --target=${electronVer} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: dst, stdio: 'inherit' },
);

console.log('双 ABI 完成:better-sqlite3=node(137), better-sqlite3-electron=electron(115)');
