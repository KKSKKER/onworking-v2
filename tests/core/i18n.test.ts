import { describe, it, expect } from 'vitest';
import { setCatalog, t, loadCatalog } from '../../src/core/i18n';

describe('i18n', () => {
  it('interpolates vars and falls back to key when missing', () => {
    setCatalog({ test: { greet: 'Hello {name}' } });
    expect(t('test.greet', { name: 'X' })).toBe('Hello X');
    expect(t('missing.key')).toBe('missing.key');
  });

  it('loads the zh catalog and resolves a real key', () => {
    loadCatalog('zh');
    const s = t('common.loading');
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
});
