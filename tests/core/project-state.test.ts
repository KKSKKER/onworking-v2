import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { ProjectState } from '../../src/core/state/project';

describe('project state', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'st-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults a big table to created phase', () => {
    const st = new ProjectState(ws);
    st.addBigTable('seq');
    expect(st.getBigTable('seq')?.phase).toBe('created');
  });

  it('moves forward through phases', () => {
    const st = new ProjectState(ws);
    st.addBigTable('seq');
    st.setPhase('seq', 'files-imported');
    st.setPhase('seq', 'mapped');
    st.setPhase('seq', 'cleaned');
    st.setPhase('seq', 'queryable');
    expect(st.getBigTable('seq')?.phase).toBe('queryable');
  });

  it('rejects backward phase transitions', () => {
    const st = new ProjectState(ws);
    st.addBigTable('seq');
    st.setPhase('seq', 'cleaned');
    expect(() => st.setPhase('seq', 'mapped')).toThrow();
  });

  it('persists state across instances', () => {
    const st = new ProjectState(ws);
    st.addBigTable('seq');
    st.setPhase('seq', 'mapped');
    st.registerFiles('seq', 12);
    st.save();
    const st2 = new ProjectState(ws);
    expect(st2.getBigTable('seq')?.phase).toBe('mapped');
    expect(st2.getBigTable('seq')?.files).toBe(12);
  });

  it('getSummary describes current state', () => {
    const st = new ProjectState(ws);
    st.addBigTable('seq');
    st.setPhase('seq', 'mapped');
    const s = st.getSummary();
    expect(s).toContain('seq');
    expect(s).toContain('mapped');
  });
});
