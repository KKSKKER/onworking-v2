// src/core/db/sqlite.ts
// 双 ABI 装载:better-sqlite3 原生模块按运行时 ABI 自动选。
//   - 系统 node(137) → node_modules/better-sqlite3(rebuild:node 编的)
//   - Electron 内置 node(115) → node_modules/better-sqlite3-electron(双 ABI 脚本编的副本)
// 先试 node 版(开内存库验证),失败(ABI 不匹配)回退 electron 版 —— 对客户端怎么 spawn 都免疫。
import type Database from 'better-sqlite3';

type DbCtor = typeof Database;

let cached: DbCtor | null = null;

function tryLoad(pkg: string): DbCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeRequire = typeof require === 'function' ? (require as NodeRequire) : null;
  if (!nodeRequire) {
    throw new Error('sqlite loader: require unavailable in this module context');
  }
  const mod = nodeRequire(pkg) as unknown as { default?: DbCtor };
  const ctor = (mod.default ?? mod) as DbCtor;
  // 验证 ABI:能开内存库说明 ABI 匹配,否则抛错走回退
  const probe = new ctor(':memory:');
  probe.close();
  return ctor;
}

/** 返回与当前进程 ABI 匹配的 better-sqlite3 构造器。 */
export function loadSqlite(): DbCtor {
  if (cached) return cached;
  try {
    cached = tryLoad('better-sqlite3');
  } catch {
    cached = tryLoad('better-sqlite3-electron');
  }
  return cached;
}
