// src/types/unzipper.d.ts
// unzipper@0.12.5 无类型声明,声明本项目用到的子集(Open.file → files[] → stream/buffer)。
declare module 'unzipper' {
  export interface Entry {
    path: string;
    type: 'File' | 'Directory';
    stream(): import('node:stream').Readable;
    buffer(): Promise<Buffer>;
  }
  export interface CentralDirectory {
    files: Entry[];
  }
  export const Open: {
    file(filePath: string): Promise<CentralDirectory>;
  };
}
