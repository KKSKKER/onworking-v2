import type { IpcRequest } from '../ipc/contracts';

declare global {
  interface Window {
    onw: {
      cli(request: IpcRequest): void;
      onCliEvent(cb: (line: string) => void): () => void;
      onCliError(cb: (line: string) => void): () => void;
      onWorkspaceChanged(cb: () => void): () => void;
      openWorkspace(path: string): Promise<{ ok: boolean }>;
      pickWorkspace(): Promise<string | null>;
      pickFiles(): Promise<string[]>;
      pickDirectory(): Promise<string | null>;
      pickSaveCsv(defaultName: string): Promise<string | null>;
    };
  }
}

export {};
