import { describe, it, expect } from 'vitest';
import { Logger, type LogEntry } from '../../src/core/logging/logger';
import { arraySink } from '../../src/core/logging/sinks';

describe('logger', () => {
  it('writes entries to sinks with level/module/message/data', () => {
    const out: LogEntry[] = [];
    const log = new Logger();
    log.addSink(arraySink(out));
    log.info('etl/writer', 'start', { table: 'big' });
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('info');
    expect(out[0].module).toBe('etl/writer');
    expect(out[0].message).toBe('start');
    expect(out[0].data).toEqual({ table: 'big' });
    expect(typeof out[0].timestamp).toBe('string');
  });

  it('filters entries below the set threshold', () => {
    const out: LogEntry[] = [];
    const log = new Logger();
    log.addSink(arraySink(out));
    log.setLevel('warn');
    log.debug('etl', 'a');
    log.info('etl', 'b');
    log.warn('etl', 'c');
    log.error('etl', 'd');
    expect(out.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('separate Logger instances do not share sinks', () => {
    const out: LogEntry[] = [];
    const a = new Logger();
    const b = new Logger();
    a.addSink(arraySink(out));
    b.info('x', 'noop'); // b 没有 sink
    expect(out).toHaveLength(0);
  });

  it('error/warn/debug helper methods produce correct levels', () => {
    const out: LogEntry[] = [];
    const log = new Logger();
    log.addSink(arraySink(out));
    log.setLevel('debug'); // 默认 info 会滤掉 debug
    log.debug('m', 'd');
    log.info('m', 'i');
    log.warn('m', 'w');
    log.error('m', 'e');
    expect(out.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
