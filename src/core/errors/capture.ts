// src/core/errors/capture.ts
// 统一错误捕获:把任意抛错规整为 AppError 并记入日志。
import { logger } from '../logging';
import { AppError, type ErrorContext } from './app-error';

/** 任意错误 → AppError;已是 AppError 则原样返回。包装时保留真实错误信息。 */
export function normalizeError(err: unknown, ctx: ErrorContext): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError({
    ...ctx,
    message: ctx.message ? `${ctx.message}: ${message}` : message,
  });
}

/** 捕获错误:规整为 AppError,写入日志,返回给调用方处理/展示/回传 AI。 */
export function captureError(err: unknown, ctx: ErrorContext): AppError {
  const normalized = normalizeError(err, ctx);
  logger.error(ctx.module, normalized.message, {
    code: normalized.code,
    ...(normalized.data ?? {}),
  });
  return normalized;
}
