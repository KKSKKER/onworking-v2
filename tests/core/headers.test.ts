import { describe, it, expect } from 'vitest';
import { canonicalizeHeaders, resolveHeaderIndex } from '../../src/core/etl/headers';

describe('canonicalizeHeaders', () => {
  it('keeps single-occurrence headers unchanged', () => {
    expect(canonicalizeHeaders(['日期', '借方金额']).names).toEqual(['日期', '借方金额']);
    expect(canonicalizeHeaders(['日期']).duplicateOf.size).toBe(0);
  });
  it('numbers duplicate headers 姓名_1..N in column order', () => {
    const c = canonicalizeHeaders(['姓名', '出生日期', '姓名', '账号', '姓名']);
    expect(c.names).toEqual(['姓名_1', '出生日期', '姓名_2', '账号', '姓名_3']);
    expect(c.duplicateOf.get('姓名')).toEqual(['姓名_1', '姓名_2', '姓名_3']);
  });
  it('handles mixed duplicates and singles', () => {
    expect(canonicalizeHeaders(['姓名', '姓名', '账号']).names).toEqual(['姓名_1', '姓名_2', '账号']);
  });
  it('skips a suffix that collides with an existing raw header', () => {
    // 原始表头恰好有 姓名_1(独立列) + 两个裸 姓名 → 裸名组编号顺延为 姓名_2/姓名_3
    const c = canonicalizeHeaders(['姓名', '姓名_1', '姓名']);
    expect(c.names).toEqual(['姓名_2', '姓名_1', '姓名_3']);
    expect(c.duplicateOf.get('姓名')).toEqual(['姓名_2', '姓名_3']);
  });
  it('returns empty arrays for empty input', () => {
    const c = canonicalizeHeaders([]);
    expect(c.names).toEqual([]);
    expect(c.duplicateOf.size).toBe(0);
  });
});

describe('resolveHeaderIndex', () => {
  const canonical = canonicalizeHeaders(['姓名', '出生日期', '姓名', '账号', '姓名']);
  it('resolves a numbered name to its column index', () => {
    expect(resolveHeaderIndex(canonical, '姓名_2')).toEqual({ kind: 'ok', index: 2 });
    expect(resolveHeaderIndex(canonical, '出生日期')).toEqual({ kind: 'ok', index: 1 });
  });
  it('returns duplicate-bare error when a bare name has duplicates', () => {
    const r = resolveHeaderIndex(canonical, '姓名');
    expect(r.kind).toBe('duplicate-bare');
    if (r.kind === 'duplicate-bare') {
      expect(r.error).toContain('姓名_1');
      expect(r.error).toContain('姓名_2');
      expect(r.error).toContain('姓名_3');
    }
  });
  it('returns ok with undefined index for an absent name (lenient)', () => {
    expect(resolveHeaderIndex(canonical, '不存在')).toEqual({ kind: 'ok', index: undefined });
  });
  it('resolves a bare name to index when no duplicates exist', () => {
    const single = canonicalizeHeaders(['姓名', '账号']);
    expect(resolveHeaderIndex(single, '姓名')).toEqual({ kind: 'ok', index: 0 });
  });
});
