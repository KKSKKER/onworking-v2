import type { ApiCommand, ApiResult } from '../ipc/contracts';

declare global {
  interface Window {
    onw: {
      invoke(command: ApiCommand): Promise<ApiResult<unknown>>;
      onProgress(cb: (payload: unknown) => void): () => void;
      onLog(cb: (entry: unknown) => void): () => void;
    };
  }
}

export {};
