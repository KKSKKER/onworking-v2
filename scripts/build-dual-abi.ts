// scripts/build-dual-abi.ts
// 双 ABI 构建:让 better-sqlite3 同时可用系统 node(137) 和 Electron(115)。
//  1) 复制 node_modules/better-sqlite3 → better-sqlite3-electron(副本)
//  2) 改副本包名(避免混淆)
//  3) node-gyp 直建副本 → Electron ABI(115)(只动副本,不碰被占用的原件)
// 结果:原件 better-sqlite3=node(137),副本 better-sqlite3-electron=electron(115);
//      运行时 src/core/db/sqlite.ts 按进程 ABI 自动选。
// 用法: npm run build:dual-abi
import { execSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'node_modules', 'better-sqlite3');
const dst = join(root, 'node_modules', 'better-sqlite3-electron');
// Electron 主版本(devDeps electron ^31 → ABI 115)
const electronVer = '31.7.7';

console.log('[1/3] 复制 better-sqlite3 → better-sqlite3-electron');
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });

console.log('[2/3] 改副本包名');
const pj = join(dst, 'package.json');
const cfg = JSON.parse(readFileSync(pj, 'utf8')) as { name: string };
cfg.name = 'better-sqlite3-electron';
writeFileSync(pj, JSON.stringify(cfg, null, 2), 'utf8');

console.log('[3/3] node-gyp 直建副本 → Electron ABI(115)');
execSync(
  `npx node-gyp rebuild --runtime=electron --target=${electronVer} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: dst, stdio: 'inherit' },
);

console.log('双 ABI 完成:better-sqlite3=node(137,未动), better-sqlite3-electron=electron(115)');
