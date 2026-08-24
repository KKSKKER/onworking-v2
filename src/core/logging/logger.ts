// src/core/logging/logger.ts
// 结构化日志核心:Logger 类 + 级别过滤 + 可插拔 sink。
// 默认不注册任何 sink —— 由应用入口(CLI demo / Electron main)注入 console/file/UI sink。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private sinks: LogSink[] = [];
  private threshold: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.threshold = level;
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  clearSinks(): void {
    this.sinks = [];
  }

  log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.threshold]) return;
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, module, message, data };
    for (const sink of this.sinks) sink(entry);
  }

  debug(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', module, message, data);
  }

  info(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', module, message, data);
  }

  warn(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', module, message, data);
  }

  error(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('error', module, message, data);
  }
}
