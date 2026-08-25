import type { ApiCommand, ApiResult, IpcRequest } from '../ipc/contracts';

declare global {
  interface Window {
    onw: {
      // 新 API:CLI 桥
      cli(request: IpcRequest): void;
      onCliEvent(cb: (line: string) => void): () => void;
      onCliError(cb: (line: string) => void): () => void;
      onWorkspaceChanged(cb: () => void): () => void;
      openWorkspace(path: string): Promise<{ ok: boolean }>;
      pickWorkspace(): Promise<string | null>;
      // 旧 API(临时保留,T9 移除)
      invoke(command: ApiCommand): Promise<ApiResult<unknown>>;
      onProgress(cb: (payload: unknown) => void): () => void;
      onLog(cb: (entry: unknown) => void): () => void;
    };
  }
}

export {};
