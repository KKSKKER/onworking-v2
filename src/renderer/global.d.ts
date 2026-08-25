import type { ApiCommand, ApiResult } from '../ipc/contracts';

declare global {
  interface Window {
    onw: {
      invoke(command: ApiCommand): Promise<ApiResult<unknown>>;
      pickWorkspace(): Promise<string | null>;
      onProgress(cb: (payload: unknown) => void): () => void;
      onLog(cb: (entry: unknown) => void): () => void;
    };
  }
}

export {};
