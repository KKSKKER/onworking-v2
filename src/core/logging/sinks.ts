// src/core/logging/sinks.ts
// 日志 sink:console(人类可读)/ array(测试用)。
import type { LogEntry, LogSink } from './logger';

export function consoleSink(): LogSink {
  return (entry: LogEntry) => {
    const prefix = `[${entry.timestamp}] ${entry.level.toUpperCase().padEnd(5)} ${entry.module}:`;
    const body = entry.data ? `${entry.message} ${JSON.stringify(entry.data)}` : entry.message;
    if (entry.level === 'error') console.error(prefix, body);
    else if (entry.level === 'warn') console.warn(prefix, body);
    else console.log(prefix, body);
  };
}

/** 收集日志到数组,测试/内存暂存用。 */
export function arraySink(out: LogEntry[]): LogSink {
  return (entry: LogEntry) => {
    out.push(entry);
  };
}
