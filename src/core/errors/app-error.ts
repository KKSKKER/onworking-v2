// src/core/errors/app-error.ts
// 结构化错误:统一携带 module / code / data,便于日志、UI(红字)与 AI 回传。
export interface ErrorContext {
  module: string;
  code: string;
  message?: string;
  data?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: string;
  readonly module: string;
  readonly data?: Record<string, unknown>;

  constructor(ctx: ErrorContext) {
    super(ctx.message ?? ctx.code);
    this.name = 'AppError';
    this.code = ctx.code;
    this.module = ctx.module;
    this.data = ctx.data;
  }
}
