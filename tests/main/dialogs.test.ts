import { describe, it, expect } from 'vitest';
import { saveCsvDialog, type SaveDialogLike } from '../../src/main/dialogs';

describe('saveCsvDialog', () => {
  it('用户选路径 → 返回该路径,过滤器为 .csv', async () => {
    const dialog: SaveDialogLike = {
      showSaveDialog: async (o) => {
        expect(o.defaultPath).toBe('seq.csv');
        expect(o.filters[0].extensions).toEqual(['csv']);
        return { canceled: false, filePath: 'D:/demo/exports/seq.csv' };
      },
    };
    const p = await saveCsvDialog(dialog, 'seq.csv');
    expect(p).toBe('D:/demo/exports/seq.csv');
  });

  it('用户取消 → 返回 null', async () => {
    const dialog: SaveDialogLike = {
      showSaveDialog: async () => ({ canceled: true }),
    };
    const p = await saveCsvDialog(dialog, 'seq.csv');
    expect(p).toBeNull();
  });
});
