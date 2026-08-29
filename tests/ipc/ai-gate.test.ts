import { describe, it, expect, afterEach } from 'vitest';
import {
  isAiAllowed,
  buildAiRestrictedError,
  parseRequestLine,
  makeEnvelope,
  AUTH_SECRET_ENV,
} from '../../src/ipc/ai-gate';

describe('ai-gate isAiAllowed', () => {
  it('external 模式放行元数据 + schema/配置/管线管理,拒绝真实数据 API', () => {
    // 元数据
    expect(isAiAllowed('external', 'state.summary')).toBe(true);
    expect(isAiAllowed('external', 'bigtable.list')).toBe(true);
    expect(isAiAllowed('external', 'schema.tables')).toBe(true);
    expect(isAiAllowed('external', 'vcs.status')).toBe(true);
    expect(isAiAllowed('external', 'settings.get')).toBe(true);
    // schema/配置命令(只碰字段定义/sheet 名/映射/模板,不碰业务行数据)
    expect(isAiAllowed('external', 'bigtable.save')).toBe(true);
    expect(isAiAllowed('external', 'bigtable.get')).toBe(true);
    expect(isAiAllowed('external', 'bigtable.sourceFiles')).toBe(true);
    expect(isAiAllowed('external', 'setup.sheets')).toBe(true);
    expect(isAiAllowed('external', 'setup.detectSource')).toBe(true);
    expect(isAiAllowed('external', 'mapping.save')).toBe(true);
    expect(isAiAllowed('external', 'template.save')).toBe(true);
    // 管线管理(建/删/跑 + 拷贝源文件)
    expect(isAiAllowed('external', 'pipeline.save')).toBe(true);
    expect(isAiAllowed('external', 'pipeline.run')).toBe(true);
    expect(isAiAllowed('external', 'pipeline.delete')).toBe(true);
    expect(isAiAllowed('external', 'bigtable.addFiles')).toBe(true);
    // 真实数据读写仍封
    expect(isAiAllowed('external', 'query.run')).toBe(false);
    expect(isAiAllowed('external', 'bigtable.previewRows')).toBe(false);
    expect(isAiAllowed('external', 'setup.preview')).toBe(false);
    // CSV 导出(交付物):仅 SELECT 落盘,不暴露写库能力,external 放行
    expect(isAiAllowed('external', 'query.exportCsv')).toBe(true);
    expect(isAiAllowed('external', 'bigtable.exportCsv')).toBe(true);
    expect(isAiAllowed('external', 'setup.exportCsv')).toBe(true);
    // 堆叠多表候选检测仅本地模式可用:候选含未确认行,外部模型可能误判表头
    expect(isAiAllowed('external', 'setup.detectHeaders')).toBe(false);
  });

  it('local 模式放行一切', () => {
    expect(isAiAllowed('local', 'query.run')).toBe(true);
    expect(isAiAllowed('local', 'bigtable.addFiles')).toBe(true);
    expect(isAiAllowed('local', 'bigtable.previewRows')).toBe(true);
    expect(isAiAllowed('local', 'state.summary')).toBe(true);
    expect(isAiAllowed('local', 'setup.detectHeaders')).toBe(true);
  });
});

describe('ai-gate buildAiRestrictedError', () => {
  it('普通受限 API 返回 AI_MODE_RESTRICTED 并含命令名', () => {
    const e = buildAiRestrictedError('external', 'query.run');
    expect(e.code).toBe('AI_MODE_RESTRICTED');
    expect(e.message).toContain('query.run');
  });

  it('settings.setAiMode 返回专用文案(仅界面可设置)', () => {
    const e = buildAiRestrictedError('external', 'settings.setAiMode');
    expect(e.code).toBe('AI_MODE_RESTRICTED');
    expect(e.message).toContain('仅界面可设置');
  });
});

describe('ai-gate auth envelope', () => {
  const oldEnv = process.env[AUTH_SECRET_ENV];
  afterEach(() => {
    if (oldEnv === undefined) delete process.env[AUTH_SECRET_ENV];
    else process.env[AUTH_SECRET_ENV] = oldEnv;
  });

  it('env 秘密匹配时信封标记为可信(人类)', () => {
    process.env[AUTH_SECRET_ENV] = 's3cret';
    const line = JSON.stringify(makeEnvelope('s3cret', { cmd: 'bigtable.list', reqId: 1 }));
    const { req, trusted } = parseRequestLine(line);
    expect(trusted).toBe(true);
    expect(req.cmd).toBe('bigtable.list');
  });

  it('裸请求无信封 → 不可信(AI)', () => {
    process.env[AUTH_SECRET_ENV] = 's3cret';
    const { req, trusted } = parseRequestLine(JSON.stringify({ cmd: 'bigtable.list', reqId: 2 }));
    expect(trusted).toBe(false);
    expect(req.cmd).toBe('bigtable.list');
  });

  it('秘密不匹配 → 不可信', () => {
    process.env[AUTH_SECRET_ENV] = 's3cret';
    const line = JSON.stringify(makeEnvelope('wrong', { cmd: 'query.run', sql: 'SELECT 1', reqId: 3 }));
    const { req, trusted } = parseRequestLine(line);
    expect(trusted).toBe(false);
    expect(req.cmd).toBe('query.run');
  });

  it('进程未设秘密 → 任何信封都不可信', () => {
    delete process.env[AUTH_SECRET_ENV];
    const line = JSON.stringify(makeEnvelope('s3cret', { cmd: 'query.run', sql: 'SELECT 1', reqId: 4 }));
    const { trusted } = parseRequestLine(line);
    expect(trusted).toBe(false);
  });
});
