// src/main/dialogs.ts
// 保存对话框的纯函数封装:便于单测,不打 Electron。用 app 级对话框(无窗口句柄,单参数重载)。
export interface SaveDialogLike {
  showSaveDialog(options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

export async function saveCsvDialog(
  dialog: SaveDialogLike,
  defaultName: string,
): Promise<string | null> {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}
