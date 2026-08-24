import { describe, it, expect } from 'vitest';
import { version } from '../../src/core/index';

describe('core smoke', () => {
  it('exports a version', () => {
    expect(typeof version).toBe('string');
  });
});
