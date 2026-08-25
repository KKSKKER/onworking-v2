// 安装后自动生成双 ABI 副本(better-sqlite3-electron),让原生模块同时兼容系统 node 和 Electron。
// 尽力而为:失败只警告、不阻断 npm install(可稍后手动跑 npm run build:dual-abi)。
const { execSync } = require('child_process');
try {
  execSync('npm run build:dual-abi', { stdio: 'inherit' });
  console.log('[postinstall] 双 ABI 构建完成');
} catch (e) {
  console.warn('[postinstall] build:dual-abi 跳过(可稍后手动运行 npm run build:dual-abi):', String(e.message).split('\n')[0]);
}
