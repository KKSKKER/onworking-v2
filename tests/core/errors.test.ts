import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import { normalizeError, captureError } from '../../src/core/errors/capture';
import { logger } from '../../src/core/logging';
import { arraySink } from '../../src/core/logging/sinks';
import type { LogEntry } from '../../src/core/logging/logger';

describe('errors', () => {
  beforeEach(() => logger.clearSinks());
  afterEach(() => logger.clearSinks());

  it('AppError carries code/module/message/data', () => {
    const err = new AppError({
      module: 'etl',
      code: 'ETL_FAILED',
      message: 'boom',
      data: { table: 't' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ETL_FAILED');
    expect(err.module).toBe('etl');
    expect(err.data).toEqual({ table: 't' });
    expect(err.message).toBe('boom');
  });

  it('normalizeError passes AppError through unchanged', () => {
    const original = new AppError({ module: 'etl', code: 'ETL_FAILED' });
    expect(normalizeError(original, { module: 'x', code: 'OTHER' })).toBe(original);
  });

  it('normalizeError wraps unknown errors into AppError with code/module', () => {
    const err = normalizeError(new Error('nope'), { module: 'etl', code: 'ETL_FAILED' });
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('ETL_FAILED');
    expect(err.message).toBe('nope');
  });

  it('captureError logs the error to the logger and returns normalized', () => {
    const out: LogEntry[] = [];
    logger.addSink(arraySink(out));
    const err = captureError(new Error('nope'), { module: 'etl', code: 'ETL_FAILED' });
    expect(err).toBeInstanceOf(AppError);
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('error');
    expect(out[0].module).toBe('etl');
    expect(out[0].data?.code).toBe('ETL_FAILED');
  });
});
