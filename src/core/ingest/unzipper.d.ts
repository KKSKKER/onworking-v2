// src/core/ingest/unzipper.d.ts
// unzipper@0.12.5 无内置类型(无 types 字段亦无 .d.ts);@types/unzipper 已过时(对应 0.10,Entry 无 stream())。故本文件
// 以 lib/Open/directory.js 运行时形状为准,只声明 xlsx-reader.ts 实际用到的 API。勿随意外扩 —— 用到再加。
declare module 'unzipper' {
  import type { Readable } from 'node:stream';

  /** Open.file() 解析中央目录后的返回(即 lib/Open/directory.js 的 vars,await 后 files 已物化为数组)。 */
  export interface CentralDirectory {
    /** 中央目录每条记录(仅元数据,数据本体须经 entry.stream()/buffer() 按需读取)。 */
    files: Entry[];
  }

  /** 单条 zip 记录:path 为相对 zip 根的路径(原样,可能含反斜杠)。 */
  export interface Entry {
    path: string;
    type: 'File' | 'Directory';
    /** 流式读取解压内容(PassThrough,支持异步迭代与 destroy)。 */
    stream(password?: string): Readable;
    /** 整体读取解压内容为 Buffer。 */
    buffer(password?: string): Promise<Buffer>;
  }

  export namespace Open {
    /** 打开本地 zip 文件,解析中央目录(不读取文件数据本体)。 */
    function file(filename: string, options?: Record<string, unknown>): Promise<CentralDirectory>;
  }
}
