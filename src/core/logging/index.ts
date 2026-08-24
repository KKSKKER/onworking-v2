import { Logger } from './logger';
import { consoleSink } from './sinks';

export { Logger } from './logger';
export type { LogEntry, LogLevel, LogSink } from './logger';
export { consoleSink, arraySink } from './sinks';

/** 全局单例日志器。入口处可注册 sink;默认无 sink(由入口决定)。 */
export const logger = new Logger();

/** 便捷:注册 console sink(CLI demo / Electron main 启动时调用一次)。 */
export function useConsoleLogging(level?: Parameters<Logger['setLevel']>[0]): void {
  if (level) logger.setLevel(level);
  logger.clearSinks();
  logger.addSink(consoleSink());
}
